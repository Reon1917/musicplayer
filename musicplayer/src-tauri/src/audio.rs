use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Condvar, Mutex, RwLock,
};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde::Serialize;
use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::formats::TrackType;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::{AppHandle, Emitter};

use crate::db::Song;

const FFT_SIZE: usize = 2048;
const VISUALIZER_BINS: usize = 64;
const VOCAL_BINS: usize = 48;
const MIN_VISUAL_HZ: f32 = 30.0;
const DB_FLOOR: f32 = -60.0;
const DB_CEILING: f32 = 0.0;
const BASS_LOW_HZ: f32 = 20.0;
const BASS_HIGH_HZ: f32 = 150.0;
const VOCAL_LOW_HZ: f32 = 250.0;
const VOCAL_HIGH_HZ: f32 = 4_000.0;
const DECODE_CACHE_LIMIT: usize = 3;

#[derive(Clone)]
struct TrackAudio {
    song_id: String,
    title: String,
    artist: Option<String>,
    samples: Arc<Vec<f32>>,
    sample_rate: u32,
    duration_seconds: f64,
}

#[derive(Clone)]
struct DecodedTrack {
    samples: Arc<Vec<f32>>,
    sample_rate: u32,
    duration_seconds: f64,
}

struct DecodedTrackCache {
    tracks: HashMap<String, DecodedTrack>,
    order: VecDeque<String>,
    in_flight: HashMap<String, Arc<DecodeSlot>>,
}

struct DecodeSlot {
    result: Mutex<Option<Result<DecodedTrack, String>>>,
    ready: Condvar,
}

impl DecodeSlot {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn wait(&self) -> Result<DecodedTrack, String> {
        let mut result = self.result.lock().map_err(|err| err.to_string())?;
        loop {
            if let Some(result) = result.clone() {
                return result;
            }
            result = self.ready.wait(result).map_err(|err| err.to_string())?;
        }
    }
}

impl DecodedTrackCache {
    fn new() -> Self {
        Self {
            tracks: HashMap::new(),
            order: VecDeque::new(),
            in_flight: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<DecodedTrack> {
        let decoded = self.tracks.get(key).cloned()?;
        self.touch(key);
        Some(decoded)
    }

    fn contains(&self, key: &str) -> bool {
        self.tracks.contains_key(key)
    }

    fn in_flight(&self, key: &str) -> bool {
        self.in_flight.contains_key(key)
    }

    fn insert_in_flight(&mut self, key: String, slot: Arc<DecodeSlot>) {
        self.in_flight.insert(key, slot);
    }

    fn insert(&mut self, key: String, decoded: DecodedTrack) {
        self.tracks.insert(key.clone(), decoded);
        self.touch(&key);
        while self.order.len() > DECODE_CACHE_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.tracks.remove(&oldest);
            }
        }
    }

    fn touch(&mut self, key: &str) {
        if let Some(index) = self.order.iter().position(|stored| stored == key) {
            self.order.remove(index);
        }
        self.order.push_back(key.to_string());
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub song_id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub is_playing: bool,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerFrame {
    pub timestamp: f64,
    pub volume: f32,
    pub bass_pulse: f32,
    pub bass: f32,
    pub mids: f32,
    pub treble: f32,
    pub left_level: f32,
    pub right_level: f32,
    pub frequency_bins: Vec<f32>,
    pub vocal_bins: Vec<f32>,
    pub waveform: Vec<f32>,
    pub peaks: Vec<f32>,
}

pub struct Player {
    current: Arc<RwLock<Option<TrackAudio>>>,
    cursor_frame: Arc<AtomicUsize>,
    playing: Arc<AtomicBool>,
    volume: Arc<RwLock<f32>>,
    stream: Mutex<Option<Stream>>,
    output_sample_rate: Mutex<Option<u32>>,
    last_frame: Arc<Mutex<Option<VisualizerFrame>>>,
    visualizer_epoch: Arc<AtomicUsize>,
    play_request_epoch: Arc<AtomicUsize>,
    decode_cache: Arc<Mutex<DecodedTrackCache>>,
}

impl Player {
    pub fn new() -> Self {
        Self {
            current: Arc::new(RwLock::new(None)),
            cursor_frame: Arc::new(AtomicUsize::new(0)),
            playing: Arc::new(AtomicBool::new(false)),
            volume: Arc::new(RwLock::new(0.8)),
            stream: Mutex::new(None),
            output_sample_rate: Mutex::new(None),
            last_frame: Arc::new(Mutex::new(None)),
            visualizer_epoch: Arc::new(AtomicUsize::new(0)),
            play_request_epoch: Arc::new(AtomicUsize::new(0)),
            decode_cache: Arc::new(Mutex::new(DecodedTrackCache::new())),
        }
    }

    pub fn play_song(&self, song: Song, app: AppHandle) -> Result<PlayerStatus, String> {
        self.ensure_stream()?;
        let output_rate = self.output_sample_rate()?;
        let cache_key = decoded_cache_key(&song.id, output_rate);
        let request_epoch = self.play_request_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        self.playing.store(false, Ordering::Relaxed);
        let decoded = self.get_or_decode_song(&song, output_rate, &cache_key)?;
        if self.play_request_epoch.load(Ordering::Relaxed) != request_epoch {
            return Ok(self.status());
        }
        let track = TrackAudio {
            song_id: song.id.clone(),
            title: song.title.clone().unwrap_or(song.file_name.clone()),
            artist: song.artist.clone(),
            duration_seconds: decoded.duration_seconds,
            sample_rate: decoded.sample_rate,
            samples: decoded.samples,
        };

        *self.current.write().map_err(|err| err.to_string())? = Some(track);
        self.cursor_frame.store(0, Ordering::Relaxed);
        self.playing.store(true, Ordering::Relaxed);
        let epoch = self.visualizer_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        self.start_visualizer_loop(app, epoch);
        Ok(self.status())
    }

    pub fn preload_song(&self, song: Song) -> Result<(), String> {
        self.ensure_stream()?;
        let output_rate = self.output_sample_rate()?;
        let cache_key = decoded_cache_key(&song.id, output_rate);

        if self
            .decode_cache
            .lock()
            .map_err(|err| err.to_string())?
            .contains(&cache_key)
        {
            return Ok(());
        }

        let slot = Arc::new(DecodeSlot::new());
        {
            let mut cache = self.decode_cache.lock().map_err(|err| err.to_string())?;
            if cache.contains(&cache_key) || cache.in_flight(&cache_key) {
                return Ok(());
            }
            cache.insert_in_flight(cache_key.clone(), Arc::clone(&slot));
        }

        let decode_cache = Arc::clone(&self.decode_cache);
        thread::spawn(move || {
            let decoded =
                decode_audio_file(Path::new(&song.file_path), output_rate).map(|decoded| {
                    DecodedTrack {
                        samples: Arc::new(decoded.samples),
                        sample_rate: decoded.sample_rate,
                        duration_seconds: decoded.duration_seconds,
                    }
                });
            finish_decode(&decode_cache, &cache_key, &slot, decoded);
        });

        Ok(())
    }

    pub fn pause(&self) -> Result<PlayerStatus, String> {
        self.playing.store(false, Ordering::Relaxed);
        Ok(self.status())
    }

    pub fn resume(&self) -> Result<PlayerStatus, String> {
        if self
            .current
            .read()
            .map_err(|err| err.to_string())?
            .is_some()
        {
            self.playing.store(true, Ordering::Relaxed);
        }
        Ok(self.status())
    }

    pub fn stop(&self) -> Result<PlayerStatus, String> {
        self.playing.store(false, Ordering::Relaxed);
        self.cursor_frame.store(0, Ordering::Relaxed);
        Ok(self.status())
    }

    pub fn seek(&self, position_seconds: f64) -> Result<PlayerStatus, String> {
        if let Some(track) = self.current.read().map_err(|err| err.to_string())?.as_ref() {
            let frame = (position_seconds.max(0.0) * f64::from(track.sample_rate)) as usize;
            let max_frame = track.samples.len() / 2;
            self.cursor_frame
                .store(frame.min(max_frame), Ordering::Relaxed);
        }
        Ok(self.status())
    }

    pub fn set_volume(&self, volume: f32) -> Result<PlayerStatus, String> {
        *self.volume.write().map_err(|err| err.to_string())? = volume.clamp(0.0, 1.0);
        Ok(self.status())
    }

    pub fn status(&self) -> PlayerStatus {
        let current = self.current.read().ok().and_then(|guard| guard.clone());
        let volume = self.volume.read().map(|guard| *guard).unwrap_or(0.8);
        if let Some(track) = current {
            let position_seconds =
                self.cursor_frame.load(Ordering::Relaxed) as f64 / f64::from(track.sample_rate);
            PlayerStatus {
                song_id: Some(track.song_id),
                title: Some(track.title),
                artist: track.artist,
                is_playing: self.playing.load(Ordering::Relaxed),
                position_seconds,
                duration_seconds: track.duration_seconds,
                volume,
            }
        } else {
            PlayerStatus {
                song_id: None,
                title: None,
                artist: None,
                is_playing: false,
                position_seconds: 0.0,
                duration_seconds: 0.0,
                volume,
            }
        }
    }

    pub fn last_visualizer_frame(&self) -> Option<VisualizerFrame> {
        self.last_frame.lock().ok().and_then(|guard| guard.clone())
    }

    fn output_sample_rate(&self) -> Result<u32, String> {
        self.output_sample_rate
            .lock()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "Audio output is not initialized".to_string())
    }

    fn get_or_decode_song(
        &self,
        song: &Song,
        output_rate: u32,
        cache_key: &str,
    ) -> Result<DecodedTrack, String> {
        if let Some(decoded) = self
            .decode_cache
            .lock()
            .map_err(|err| err.to_string())?
            .get(cache_key)
        {
            return Ok(decoded);
        }

        let slot = Arc::new(DecodeSlot::new());
        let existing_slot = {
            let mut cache = self.decode_cache.lock().map_err(|err| err.to_string())?;
            if let Some(decoded) = cache.get(cache_key) {
                return Ok(decoded);
            }
            if let Some(slot) = cache.in_flight.get(cache_key) {
                Some(Arc::clone(slot))
            } else {
                cache.insert_in_flight(cache_key.to_string(), Arc::clone(&slot));
                None
            }
        };

        if let Some(slot) = existing_slot {
            return slot.wait();
        }

        let decoded = decode_audio_file(Path::new(&song.file_path), output_rate).map(|decoded| {
            DecodedTrack {
                samples: Arc::new(decoded.samples),
                sample_rate: decoded.sample_rate,
                duration_seconds: decoded.duration_seconds,
            }
        });
        finish_decode(&self.decode_cache, cache_key, &slot, decoded.clone());
        decoded
    }

    fn ensure_stream(&self) -> Result<(), String> {
        if self.stream.lock().map_err(|err| err.to_string())?.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "No default audio output device found".to_string())?;
        let supported_config = device
            .default_output_config()
            .map_err(|err| err.to_string())?;
        let sample_format = supported_config.sample_format();
        let config: StreamConfig = supported_config.into();
        *self
            .output_sample_rate
            .lock()
            .map_err(|err| err.to_string())? = Some(config.sample_rate);

        let err_fn = |err| eprintln!("audio output stream error: {err}");
        let stream = match sample_format {
            SampleFormat::F32 => self.build_stream::<f32>(&device, &config, err_fn),
            SampleFormat::I16 => self.build_stream::<i16>(&device, &config, err_fn),
            SampleFormat::U16 => self.build_stream::<u16>(&device, &config, err_fn),
            SampleFormat::I8 => self.build_stream::<i8>(&device, &config, err_fn),
            SampleFormat::U8 => self.build_stream::<u8>(&device, &config, err_fn),
            sample_format => Err(format!("Unsupported output sample format: {sample_format}")),
        }?;

        stream.play().map_err(|err| err.to_string())?;
        *self.stream.lock().map_err(|err| err.to_string())? = Some(stream);
        Ok(())
    }

    fn build_stream<T>(
        &self,
        device: &cpal::Device,
        config: &StreamConfig,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
    ) -> Result<Stream, String>
    where
        T: Sample + SizedSample + FromSample<f32>,
    {
        let current = Arc::clone(&self.current);
        let cursor = Arc::clone(&self.cursor_frame);
        let playing = Arc::clone(&self.playing);
        let volume = Arc::clone(&self.volume);
        let output_channels = config.channels as usize;

        device
            .build_output_stream(
                config,
                move |data: &mut [T], _| {
                    write_output_data(data, output_channels, &current, &cursor, &playing, &volume);
                },
                err_fn,
                None,
            )
            .map_err(|err| err.to_string())
    }

    fn start_visualizer_loop(&self, app: AppHandle, epoch: usize) {
        let current = Arc::clone(&self.current);
        let cursor = Arc::clone(&self.cursor_frame);
        let playing = Arc::clone(&self.playing);
        let last_frame = Arc::clone(&self.last_frame);
        let visualizer_epoch = Arc::clone(&self.visualizer_epoch);

        thread::spawn(move || {
            let mut peaks = vec![0.0; VISUALIZER_BINS];
            let mut smoothed_bins = vec![0.0; VISUALIZER_BINS];
            let mut smoothed_vocal_bins = vec![0.0; VOCAL_BINS];
            let mut bass_floor = 0.05;
            let mut bass_peak = 0.22;
            let mut bass_pulse = 0.0;
            let mut planner = FftPlanner::<f32>::new();
            let fft = planner.plan_fft_forward(FFT_SIZE);
            let mut mono = vec![0.0; FFT_SIZE];
            let mut fft_buffer: Vec<Complex32> = Vec::with_capacity(FFT_SIZE);

            loop {
                thread::sleep(Duration::from_millis(33));
                if visualizer_epoch.load(Ordering::Relaxed) != epoch {
                    break;
                }

                if !playing.load(Ordering::Relaxed) {
                    continue;
                }

                let track = match current.read().ok().and_then(|guard| guard.clone()) {
                    Some(track) => track,
                    None => break,
                };

                let frame_index = cursor.load(Ordering::Relaxed);
                if frame_index >= track.samples.len() / 2 {
                    break;
                }

                let frame = build_visualizer_frame(
                    &track,
                    frame_index,
                    &mut smoothed_bins,
                    &mut smoothed_vocal_bins,
                    &mut peaks,
                    &mut bass_floor,
                    &mut bass_peak,
                    &mut bass_pulse,
                    fft.as_ref(),
                    &mut mono,
                    &mut fft_buffer,
                );
                if let Ok(mut guard) = last_frame.lock() {
                    *guard = Some(frame.clone());
                }
                let _ = app.emit("visualizer-frame", frame);
            }
        });
    }
}

fn write_output_data<T>(
    output: &mut [T],
    output_channels: usize,
    current: &Arc<RwLock<Option<TrackAudio>>>,
    cursor: &Arc<AtomicUsize>,
    playing: &Arc<AtomicBool>,
    volume: &Arc<RwLock<f32>>,
) where
    T: Sample + FromSample<f32>,
{
    let track = current.read().ok().and_then(|guard| guard.clone());
    let volume = volume.read().map(|guard| *guard).unwrap_or(0.8);

    for frame in output.chunks_mut(output_channels) {
        let (left, right) = if playing.load(Ordering::Relaxed) {
            if let Some(track) = track.as_ref() {
                let frame_index = cursor.fetch_add(1, Ordering::Relaxed);
                let sample_index = frame_index * 2;
                if sample_index + 1 < track.samples.len() {
                    (
                        track.samples[sample_index] * volume,
                        track.samples[sample_index + 1] * volume,
                    )
                } else {
                    playing.store(false, Ordering::Relaxed);
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        for (channel, sample) in frame.iter_mut().enumerate() {
            let value = match channel {
                0 => left,
                1 => right,
                _ => (left + right) * 0.5,
            };
            *sample = T::from_sample(value.clamp(-1.0, 1.0));
        }
    }
}

struct DecodedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    duration_seconds: f64,
}

fn decoded_cache_key(song_id: &str, output_rate: u32) -> String {
    format!("{song_id}:{output_rate}")
}

fn finish_decode(
    decode_cache: &Arc<Mutex<DecodedTrackCache>>,
    cache_key: &str,
    slot: &Arc<DecodeSlot>,
    decoded: Result<DecodedTrack, String>,
) {
    if let Ok(mut result) = slot.result.lock() {
        *result = Some(decoded.clone());
        slot.ready.notify_all();
    }

    if let Ok(mut cache) = decode_cache.lock() {
        cache.in_flight.remove(cache_key);
        if let Ok(decoded) = decoded {
            cache.insert(cache_key.to_string(), decoded);
        }
    }
}

fn decode_audio_file(path: &Path, output_sample_rate: u32) -> Result<DecodedAudio, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|err| err.to_string())?;
    let mut format = probed;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "No default audio track found".to_string())?;
    let codec_params = match &track.codec_params {
        Some(CodecParameters::Audio(params)) => params.clone(),
        _ => return Err("Default track is not an audio track".to_string()),
    };
    let sample_rate = codec_params.sample_rate.unwrap_or(output_sample_rate);
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|err| err.to_string())?;
    let track_id = track.id;

    let mut samples = Vec::new();
    while let Ok(Some(packet)) = format.next_packet() {
        if packet.track_id != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(_) => continue,
        };
        append_stereo_samples(&mut samples, decoded)?;
    }

    if samples.is_empty() {
        return Err("Audio file decoded to zero samples".to_string());
    }

    let samples = if sample_rate == output_sample_rate {
        samples
    } else {
        resample_stereo_linear(&samples, sample_rate, output_sample_rate)
    };
    let duration_seconds = samples.len() as f64 / 2.0 / f64::from(output_sample_rate);

    Ok(DecodedAudio {
        samples,
        sample_rate: output_sample_rate,
        duration_seconds,
    })
}

fn append_stereo_samples(
    samples: &mut Vec<f32>,
    decoded: GenericAudioBufferRef<'_>,
) -> Result<(), String> {
    let channels = decoded.spec().channels().count();
    if channels == 0 {
        return Ok(());
    }

    let mut interleaved = Vec::with_capacity(decoded.samples_interleaved());
    decoded.copy_to_vec_interleaved::<f32>(&mut interleaved);

    for frame in interleaved.chunks(channels) {
        let left = frame[0];
        let right = if channels > 1 { frame[1] } else { left };
        samples.push(left);
        samples.push(right);
    }
    Ok(())
}

fn resample_stereo_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    let source_frames = samples.len() / 2;
    if source_frames == 0 {
        return Vec::new();
    }

    let target_frames =
        ((source_frames as f64) * f64::from(target_rate) / f64::from(source_rate)).ceil() as usize;
    let mut output = Vec::with_capacity(target_frames * 2);
    let ratio = f64::from(source_rate) / f64::from(target_rate);

    for target_frame in 0..target_frames {
        let source_position = target_frame as f64 * ratio;
        let frame_a = source_position.floor() as usize;
        let frame_b = (frame_a + 1).min(source_frames - 1);
        let t = (source_position - frame_a as f64) as f32;

        let left_a = samples[frame_a * 2];
        let right_a = samples[frame_a * 2 + 1];
        let left_b = samples[frame_b * 2];
        let right_b = samples[frame_b * 2 + 1];

        output.push(left_a + (left_b - left_a) * t);
        output.push(right_a + (right_b - right_a) * t);
    }

    output
}

fn build_visualizer_frame(
    track: &TrackAudio,
    cursor_frame: usize,
    smoothed_bins: &mut [f32],
    smoothed_vocal_bins: &mut [f32],
    peaks: &mut [f32],
    bass_floor: &mut f32,
    bass_peak: &mut f32,
    bass_pulse: &mut f32,
    fft: &dyn rustfft::Fft<f32>,
    mono: &mut Vec<f32>,
    fft_buffer: &mut Vec<Complex32>,
) -> VisualizerFrame {
    let total_frames = track.samples.len() / 2;
    let start = cursor_frame.saturating_sub(FFT_SIZE / 2);
    let end = (start + FFT_SIZE).min(total_frames);
    mono.fill(0.0);
    let mut waveform = Vec::with_capacity(128);
    let mut left_acc = 0.0;
    let mut right_acc = 0.0;
    let mut mono_sum = 0.0;

    for (index, frame_index) in (start..end).enumerate() {
        let left = track.samples[frame_index * 2];
        let right = track.samples[frame_index * 2 + 1];
        let mixed = (left + right) * 0.5;
        mono[index] = mixed;
        mono_sum += mixed;
        left_acc += left.abs();
        right_acc += right.abs();
    }

    let sample_count = (end - start).max(1) as f32;
    let dc_offset = mono_sum / sample_count;
    for index in 0..(end - start) {
        let window =
            0.5 - 0.5 * ((2.0 * std::f32::consts::PI * index as f32) / FFT_SIZE as f32).cos();
        mono[index] = (mono[index] - dc_offset) * window;
    }

    let step = (FFT_SIZE / 128).max(1);
    for index in (0..FFT_SIZE).step_by(step).take(128) {
        waveform.push(mono[index]);
    }

    fft_buffer.clear();
    fft_buffer.extend(mono.iter().map(|&sample| Complex32::new(sample, 0.0)));
    fft.process(fft_buffer);

    let frequency_bins =
        build_log_frequency_bins(fft_buffer, track.sample_rate, smoothed_bins, peaks);
    let vocal_bins = build_vocal_bins(fft_buffer, track.sample_rate, smoothed_vocal_bins);
    let raw_bass =
        normalized_fft_range_energy(fft_buffer, track.sample_rate, BASS_LOW_HZ, BASS_HIGH_HZ);
    let bass_pulse_value = update_bass_pulse(raw_bass, bass_floor, bass_peak, bass_pulse);
    let max_frequency = visualizer_max_frequency(track.sample_rate);
    let bass = raw_bass;
    let mids = average_range_by_hz(&frequency_bins, VOCAL_LOW_HZ, VOCAL_HIGH_HZ, max_frequency);
    let treble = average_range_by_hz(&frequency_bins, 4_000.0, 16_000.0, max_frequency);
    let left_level = (left_acc / sample_count).clamp(0.0, 1.0);
    let right_level = (right_acc / sample_count).clamp(0.0, 1.0);
    let volume = ((left_level + right_level) * 0.5).clamp(0.0, 1.0);

    VisualizerFrame {
        timestamp: cursor_frame as f64 / f64::from(track.sample_rate),
        volume,
        bass_pulse: bass_pulse_value,
        bass,
        mids,
        treble,
        left_level,
        right_level,
        frequency_bins,
        vocal_bins,
        waveform,
        peaks: peaks.to_vec(),
    }
}

fn build_log_frequency_bins(
    fft_buffer: &[Complex32],
    sample_rate: u32,
    smoothed_bins: &mut [f32],
    peaks: &mut [f32],
) -> Vec<f32> {
    let max_frequency = visualizer_max_frequency(sample_rate);
    let mut frequency_bins = Vec::with_capacity(VISUALIZER_BINS);

    for visual_bin in 0..VISUALIZER_BINS {
        let low_hz = log_frequency_for_bin(visual_bin, VISUALIZER_BINS, max_frequency);
        let high_hz = log_frequency_for_bin(visual_bin + 1, VISUALIZER_BINS, max_frequency);
        let start_bin = frequency_to_fft_bin_ceil(low_hz, sample_rate).max(1);
        let end_bin = frequency_to_fft_bin_ceil(high_hz, sample_rate)
            .max(start_bin + 1)
            .min(fft_buffer.len() / 2);

        let mut power = 0.0;
        let mut count = 0usize;
        for bin in &fft_buffer[start_bin..end_bin] {
            let magnitude = bin.norm() / (FFT_SIZE as f32 * 0.5);
            power += magnitude * magnitude;
            count += 1;
        }

        let rms = (power / count.max(1) as f32).sqrt().max(1.0e-9);
        let db = (20.0 * rms.log10()).clamp(DB_FLOOR, DB_CEILING);
        let normalized = ((db - DB_FLOOR) / (DB_CEILING - DB_FLOOR)).clamp(0.0, 1.0);

        let current = smoothed_bins[visual_bin];
        let attack = if normalized > current { 0.42 } else { 0.12 };
        let smoothed = current + (normalized - current) * attack;
        smoothed_bins[visual_bin] = smoothed;

        peaks[visual_bin] = (peaks[visual_bin] - 0.018).max(smoothed);
        frequency_bins.push(smoothed);
    }

    frequency_bins
}

fn build_vocal_bins(
    fft_buffer: &[Complex32],
    sample_rate: u32,
    smoothed_vocal_bins: &mut [f32],
) -> Vec<f32> {
    let mut bins = Vec::with_capacity(smoothed_vocal_bins.len());

    for visual_bin in 0..smoothed_vocal_bins.len() {
        let low_hz = vocal_frequency_for_bin(visual_bin, smoothed_vocal_bins.len());
        let high_hz = vocal_frequency_for_bin(visual_bin + 1, smoothed_vocal_bins.len());
        let normalized = normalized_fft_range_energy(fft_buffer, sample_rate, low_hz, high_hz);
        let current = smoothed_vocal_bins[visual_bin];
        let attack = if normalized > current { 0.18 } else { 0.055 };
        let smoothed = current + (normalized - current) * attack;
        smoothed_vocal_bins[visual_bin] = smoothed;
        bins.push(smoothed);
    }

    bins
}

fn update_bass_pulse(
    raw_bass: f32,
    bass_floor: &mut f32,
    bass_peak: &mut f32,
    bass_pulse: &mut f32,
) -> f32 {
    *bass_floor = (*bass_floor * 0.992 + raw_bass * 0.008).min(raw_bass * 0.92);
    *bass_peak = (*bass_peak * 0.965).max(raw_bass).max(*bass_floor + 0.08);

    let dynamic_range = (*bass_peak - *bass_floor).max(0.08);
    let normalized = ((raw_bass - *bass_floor) / dynamic_range).clamp(0.0, 1.0);
    let shaped = normalized.powf(1.35);
    let attack = if shaped > *bass_pulse { 0.82 } else { 0.16 };
    *bass_pulse += (shaped - *bass_pulse) * attack;
    (*bass_pulse).clamp(0.0, 1.0)
}

fn normalized_fft_range_energy(
    fft_buffer: &[Complex32],
    sample_rate: u32,
    low_hz: f32,
    high_hz: f32,
) -> f32 {
    let start_bin = frequency_to_fft_bin_floor(low_hz, sample_rate).max(1);
    let end_bin = frequency_to_fft_bin_ceil(high_hz, sample_rate)
        .max(start_bin + 1)
        .min(fft_buffer.len() / 2);
    let mut power = 0.0;
    let mut count = 0usize;

    for bin in &fft_buffer[start_bin..end_bin] {
        let magnitude = bin.norm() / (FFT_SIZE as f32 * 0.5);
        power += magnitude * magnitude;
        count += 1;
    }

    let rms = (power / count.max(1) as f32).sqrt().max(1.0e-9);
    let db = (20.0 * rms.log10()).clamp(DB_FLOOR, DB_CEILING);
    ((db - DB_FLOOR) / (DB_CEILING - DB_FLOOR)).clamp(0.0, 1.0)
}

fn log_frequency_for_bin(index: usize, bin_count: usize, max_frequency: f32) -> f32 {
    let t = index as f32 / bin_count as f32;
    MIN_VISUAL_HZ * (max_frequency / MIN_VISUAL_HZ).powf(t)
}

fn vocal_frequency_for_bin(index: usize, bin_count: usize) -> f32 {
    let t = index as f32 / bin_count as f32;
    VOCAL_LOW_HZ * (VOCAL_HIGH_HZ / VOCAL_LOW_HZ).powf(t)
}

fn visualizer_max_frequency(sample_rate: u32) -> f32 {
    (sample_rate as f32 * 0.5)
        .min(12_000.0)
        .max(MIN_VISUAL_HZ * 2.0)
}

fn frequency_to_fft_bin_ceil(frequency: f32, sample_rate: u32) -> usize {
    ((frequency / sample_rate as f32) * FFT_SIZE as f32).ceil() as usize
}

fn frequency_to_fft_bin_floor(frequency: f32, sample_rate: u32) -> usize {
    ((frequency / sample_rate as f32) * FFT_SIZE as f32).floor() as usize
}

fn average_range_by_hz(
    frequency_bins: &[f32],
    low_hz: f32,
    high_hz: f32,
    max_frequency: f32,
) -> f32 {
    let mut total = 0.0;
    let mut count = 0usize;

    for (index, value) in frequency_bins.iter().enumerate() {
        let bin_low = log_frequency_for_bin(index, frequency_bins.len(), max_frequency);
        let bin_high = log_frequency_for_bin(index + 1, frequency_bins.len(), max_frequency);
        if bin_high >= low_hz && bin_low <= high_hz {
            total += *value;
            count += 1;
        }
    }

    if count == 0 {
        0.0
    } else {
        total / count as f32
    }
}
