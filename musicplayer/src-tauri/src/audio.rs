use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde::Serialize;
use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::TrackType;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase};
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

const STREAM_BUFFER_SECONDS: f32 = 3.0;
const START_BUFFER_SECONDS: f32 = 0.35;
const PRELOAD_SECONDS: f32 = 2.0;
const WARM_CACHE_BYTE_LIMIT: usize = 8 * 1024 * 1024;
const MEDIA_BUFFER_LEN: usize = 128 * 1024;

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

struct PlaybackCore {
    song_id: String,
    title: String,
    artist: Option<String>,
    file_path: String,
    duration_seconds: f64,
    sample_rate: u32,
    ring: Mutex<VecDeque<f32>>,
    space_available: Condvar,
    capacity_samples: usize,
    rolling: Mutex<VecDeque<f32>>,
    rolling_capacity_samples: usize,
    finished: AtomicBool,
    stop_requested: AtomicBool,
}

impl PlaybackCore {
    fn new(song: Song, sample_rate: u32) -> Self {
        let capacity_samples =
            ((sample_rate as f32 * STREAM_BUFFER_SECONDS) as usize).max(FFT_SIZE) * 2;
        Self {
            song_id: song.id,
            title: song.title.unwrap_or(song.file_name),
            artist: song.artist,
            file_path: song.file_path,
            duration_seconds: song.duration_seconds.unwrap_or(0.0),
            sample_rate,
            ring: Mutex::new(VecDeque::with_capacity(capacity_samples)),
            space_available: Condvar::new(),
            capacity_samples,
            rolling: Mutex::new(VecDeque::with_capacity(FFT_SIZE * 2)),
            rolling_capacity_samples: FFT_SIZE * 2,
            finished: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
        }
    }

    fn buffered_frames(&self) -> usize {
        self.ring.lock().map(|ring| ring.len() / 2).unwrap_or(0)
    }

    fn push_samples_blocking(&self, samples: &[f32]) {
        let mut offset = 0;
        while offset < samples.len() && !self.stop_requested.load(Ordering::Relaxed) {
            let mut ring = match self.ring.lock() {
                Ok(ring) => ring,
                Err(_) => return,
            };

            while ring.len() >= self.capacity_samples
                && !self.stop_requested.load(Ordering::Relaxed)
            {
                ring = match self.space_available.wait(ring) {
                    Ok(ring) => ring,
                    Err(_) => return,
                };
            }

            if self.stop_requested.load(Ordering::Relaxed) {
                return;
            }

            let available = self.capacity_samples.saturating_sub(ring.len());
            let count = available.min(samples.len() - offset);
            ring.extend(samples[offset..offset + count].iter().copied());
            offset += count;
        }
    }

    fn seed_samples(&self, samples: &[f32]) {
        if let Ok(mut ring) = self.ring.lock() {
            let count = samples.len().min(self.capacity_samples);
            ring.extend(samples[..count].iter().copied());
        }
    }

    fn wait_until_primed(&self, min_frames: usize, timeout: Duration) {
        let start = Instant::now();
        while !self.finished.load(Ordering::Relaxed)
            && !self.stop_requested.load(Ordering::Relaxed)
            && self.buffered_frames() < min_frames
            && start.elapsed() < timeout
        {
            thread::sleep(Duration::from_millis(8));
        }
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Relaxed);
        self.space_available.notify_all();
    }

    fn append_rolling(&self, left: f32, right: f32) {
        if let Ok(mut rolling) = self.rolling.lock() {
            rolling.push_back(left);
            rolling.push_back(right);
            while rolling.len() > self.rolling_capacity_samples {
                rolling.pop_front();
            }
        }
    }

    fn rolling_samples(&self) -> Vec<f32> {
        self.rolling
            .lock()
            .map(|rolling| rolling.iter().copied().collect())
            .unwrap_or_default()
    }
}

#[derive(Clone)]
struct WarmTrack {
    song_id: String,
    output_rate: u32,
    samples: Arc<Vec<f32>>,
}

struct WarmTrackCache {
    tracks: HashMap<String, WarmTrack>,
    order: VecDeque<String>,
    bytes: usize,
    in_flight: HashMap<String, Arc<AtomicBool>>,
}

impl WarmTrackCache {
    fn new() -> Self {
        Self {
            tracks: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            in_flight: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<WarmTrack> {
        let warm = self.tracks.get(key).cloned()?;
        self.touch(key);
        Some(warm)
    }

    fn insert_in_flight(&mut self, key: String, cancel: Arc<AtomicBool>) -> bool {
        if self.tracks.contains_key(&key) || self.in_flight.contains_key(&key) {
            return false;
        }
        self.in_flight.insert(key, cancel);
        true
    }

    fn insert(&mut self, key: String, warm: WarmTrack) {
        if let Some(existing) = self.tracks.remove(&key) {
            self.bytes = self.bytes.saturating_sub(existing.samples.len() * 4);
        }
        self.bytes += warm.samples.len() * 4;
        self.tracks.insert(key.clone(), warm);
        self.touch(&key);
        self.trim();
    }

    fn remove_in_flight(&mut self, key: &str) {
        self.in_flight.remove(key);
    }

    fn touch(&mut self, key: &str) {
        if let Some(index) = self.order.iter().position(|stored| stored == key) {
            self.order.remove(index);
        }
        self.order.push_back(key.to_string());
    }

    fn trim(&mut self) {
        while self.bytes > WARM_CACHE_BYTE_LIMIT {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.tracks.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.samples.len() * 4);
            }
        }
    }
}

pub struct Player {
    current: Arc<Mutex<Option<Arc<PlaybackCore>>>>,
    cursor_frame: Arc<AtomicUsize>,
    playing: Arc<AtomicBool>,
    volume_bits: Arc<AtomicU32>,
    stream: Mutex<Option<Stream>>,
    output_sample_rate: Mutex<Option<u32>>,
    last_frame: Arc<Mutex<Option<VisualizerFrame>>>,
    visualizer_epoch: Arc<AtomicUsize>,
    play_request_epoch: Arc<AtomicUsize>,
    warm_cache: Arc<Mutex<WarmTrackCache>>,
}

impl Player {
    pub fn new() -> Self {
        Self {
            current: Arc::new(Mutex::new(None)),
            cursor_frame: Arc::new(AtomicUsize::new(0)),
            playing: Arc::new(AtomicBool::new(false)),
            volume_bits: Arc::new(AtomicU32::new(0.8f32.to_bits())),
            stream: Mutex::new(None),
            output_sample_rate: Mutex::new(None),
            last_frame: Arc::new(Mutex::new(None)),
            visualizer_epoch: Arc::new(AtomicUsize::new(0)),
            play_request_epoch: Arc::new(AtomicUsize::new(0)),
            warm_cache: Arc::new(Mutex::new(WarmTrackCache::new())),
        }
    }

    pub fn play_song(&self, song: Song, app: AppHandle) -> Result<PlayerStatus, String> {
        validate_playable_file(&song)?;
        self.ensure_stream()?;
        let output_rate = self.output_sample_rate()?;
        let cache_key = warm_cache_key(&song.id, output_rate);
        let request_epoch = self.play_request_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        self.stop_current(true);

        let warm = self
            .warm_cache
            .lock()
            .map_err(|err| err.to_string())?
            .get(&cache_key);
        let warm_frames = warm
            .as_ref()
            .filter(|warm| warm.song_id == song.id && warm.output_rate == output_rate)
            .map(|warm| warm.samples.len() / 2)
            .unwrap_or(0);

        let core = Arc::new(PlaybackCore::new(song, output_rate));
        if let Some(warm) = warm {
            core.seed_samples(&warm.samples);
        }

        spawn_decode_worker(
            Arc::clone(&core),
            DecodeStart::AfterOutputFrames(warm_frames),
        );
        let min_frames = (output_rate as f32 * START_BUFFER_SECONDS) as usize;
        core.wait_until_primed(min_frames, Duration::from_millis(900));

        if self.play_request_epoch.load(Ordering::Relaxed) != request_epoch {
            core.request_stop();
            return Ok(self.status());
        }

        *self.current.lock().map_err(|err| err.to_string())? = Some(core);
        self.cursor_frame.store(0, Ordering::Relaxed);
        self.playing.store(true, Ordering::Relaxed);
        let epoch = self.visualizer_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        self.start_visualizer_loop(app, epoch);
        Ok(self.status())
    }

    pub fn preload_song(&self, song: Song) -> Result<(), String> {
        validate_playable_file(&song)?;
        self.ensure_stream()?;
        let output_rate = self.output_sample_rate()?;
        let cache_key = warm_cache_key(&song.id, output_rate);
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut cache = self.warm_cache.lock().map_err(|err| err.to_string())?;
            if !cache.insert_in_flight(cache_key.clone(), Arc::clone(&cancel)) {
                return Ok(());
            }
        }

        let warm_cache = Arc::clone(&self.warm_cache);
        thread::spawn(move || {
            let decoded = decode_warm_start(&song, output_rate, PRELOAD_SECONDS, &cancel);
            if let Ok(mut cache) = warm_cache.lock() {
                cache.remove_in_flight(&cache_key);
                if let Ok(samples) = decoded {
                    cache.insert(
                        cache_key,
                        WarmTrack {
                            song_id: song.id,
                            output_rate,
                            samples: Arc::new(samples),
                        },
                    );
                }
            }
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
            .lock()
            .map_err(|err| err.to_string())?
            .is_some()
        {
            self.playing.store(true, Ordering::Relaxed);
        }
        Ok(self.status())
    }

    pub fn stop(&self) -> Result<PlayerStatus, String> {
        self.stop_current(true);
        self.cursor_frame.store(0, Ordering::Relaxed);
        Ok(self.status())
    }

    pub fn seek(&self, position_seconds: f64) -> Result<PlayerStatus, String> {
        self.ensure_stream()?;
        let was_playing = self.playing.load(Ordering::Relaxed);
        let Some(current) = self
            .current
            .lock()
            .map_err(|err| err.to_string())?
            .as_ref()
            .cloned()
        else {
            return Ok(self.status());
        };

        let song = Song {
            id: current.song_id.clone(),
            file_path: current.file_path.clone(),
            file_name: current.title.clone(),
            file_type: file_extension(&current.file_path).unwrap_or_else(|| "mp3".to_string()),
            title: Some(current.title.clone()),
            artist: current.artist.clone(),
            album: None,
            album_artist: None,
            genre: None,
            year: None,
            track_number: None,
            disc_number: None,
            duration_seconds: Some(current.duration_seconds),
            bitrate: None,
            sample_rate: Some(current.sample_rate as i64),
            cover_art_path: None,
            metadata_source: "player".to_string(),
            date_added: String::new(),
            last_played: None,
            play_count: 0,
        };

        let output_rate = self.output_sample_rate()?;
        let target_seconds = position_seconds.max(0.0);
        let target_frame = (target_seconds * f64::from(output_rate)) as usize;
        let request_epoch = self.play_request_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        self.stop_current(false);
        let core = Arc::new(PlaybackCore::new(song, output_rate));
        spawn_decode_worker(Arc::clone(&core), DecodeStart::AtSeconds(target_seconds));
        let min_frames = (output_rate as f32 * START_BUFFER_SECONDS) as usize;
        core.wait_until_primed(min_frames, Duration::from_millis(900));

        if self.play_request_epoch.load(Ordering::Relaxed) != request_epoch {
            core.request_stop();
            return Ok(self.status());
        }

        *self.current.lock().map_err(|err| err.to_string())? = Some(core);
        self.cursor_frame.store(target_frame, Ordering::Relaxed);
        self.playing.store(was_playing, Ordering::Relaxed);
        Ok(self.status())
    }

    pub fn set_volume(&self, volume: f32) -> Result<PlayerStatus, String> {
        self.volume_bits
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        Ok(self.status())
    }

    pub fn status(&self) -> PlayerStatus {
        let current = self.current.lock().ok().and_then(|guard| guard.clone());
        let volume = f32::from_bits(self.volume_bits.load(Ordering::Relaxed));
        if let Some(track) = current {
            let position_seconds =
                self.cursor_frame.load(Ordering::Relaxed) as f64 / f64::from(track.sample_rate);
            PlayerStatus {
                song_id: Some(track.song_id.clone()),
                title: Some(track.title.clone()),
                artist: track.artist.clone(),
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

    fn stop_current(&self, stop_visualizer: bool) {
        self.playing.store(false, Ordering::Relaxed);
        if stop_visualizer {
            self.visualizer_epoch.fetch_add(1, Ordering::Relaxed);
        }
        if let Ok(mut current) = self.current.lock() {
            if let Some(core) = current.take() {
                core.request_stop();
            }
        }
    }

    fn output_sample_rate(&self) -> Result<u32, String> {
        self.output_sample_rate
            .lock()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "Audio output is not initialized".to_string())
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
        let volume_bits = Arc::clone(&self.volume_bits);
        let output_channels = config.channels as usize;

        device
            .build_output_stream(
                config,
                move |data: &mut [T], _| {
                    write_output_data(
                        data,
                        output_channels,
                        &current,
                        &cursor,
                        &playing,
                        &volume_bits,
                    );
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
                    if let Some(core) = current.lock().ok().and_then(|guard| guard.clone()) {
                        if core.finished.load(Ordering::Relaxed) && core.buffered_frames() == 0 {
                            break;
                        }
                    }
                    continue;
                }

                let core = match current.lock().ok().and_then(|guard| guard.clone()) {
                    Some(core) => core,
                    None => break,
                };

                let frame_index = cursor.load(Ordering::Relaxed);
                let frame = build_visualizer_frame(
                    &core.rolling_samples(),
                    core.sample_rate,
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

                if core.finished.load(Ordering::Relaxed) && core.buffered_frames() == 0 {
                    break;
                }
            }
        });
    }
}

fn write_output_data<T>(
    output: &mut [T],
    output_channels: usize,
    current: &Arc<Mutex<Option<Arc<PlaybackCore>>>>,
    cursor: &Arc<AtomicUsize>,
    playing: &Arc<AtomicBool>,
    volume_bits: &Arc<AtomicU32>,
) where
    T: Sample + FromSample<f32>,
{
    let core = current.lock().ok().and_then(|guard| guard.clone());
    let volume = f32::from_bits(volume_bits.load(Ordering::Relaxed));
    let mut ring = core.as_ref().and_then(|core| core.ring.lock().ok());

    for frame in output.chunks_mut(output_channels) {
        let mut left = 0.0;
        let mut right = 0.0;
        let mut consumed = false;

        if playing.load(Ordering::Relaxed) {
            if let (Some(core), Some(ring)) = (core.as_ref(), ring.as_mut()) {
                if ring.len() >= 2 {
                    left = ring.pop_front().unwrap_or(0.0) * volume;
                    right = ring.pop_front().unwrap_or(0.0) * volume;
                    consumed = true;
                    core.append_rolling(left, right);
                    cursor.fetch_add(1, Ordering::Relaxed);
                } else if core.finished.load(Ordering::Relaxed) {
                    playing.store(false, Ordering::Relaxed);
                }
            }
        }

        for (channel, sample) in frame.iter_mut().enumerate() {
            let value = match channel {
                0 => left,
                1 => right,
                _ => (left + right) * 0.5,
            };
            *sample = T::from_sample(value.clamp(-1.0, 1.0));
        }

        if consumed {
            if let Some(core) = core.as_ref() {
                core.space_available.notify_one();
            }
        }
    }
}

enum DecodeStart {
    AfterOutputFrames(usize),
    AtSeconds(f64),
}

fn spawn_decode_worker(core: Arc<PlaybackCore>, start: DecodeStart) {
    thread::spawn(move || {
        let result = stream_decode_to_core(&core, start);
        if let Err(error) = result {
            eprintln!("audio decode error: {error}");
        }
        core.finished.store(true, Ordering::Relaxed);
        core.space_available.notify_all();
    });
}

fn stream_decode_to_core(core: &PlaybackCore, start: DecodeStart) -> Result<(), String> {
    let mut reader = AudioReader::open(Path::new(&core.file_path), core.sample_rate)?;
    let mut packet_samples = Vec::new();
    let mut skip_samples = match start {
        DecodeStart::AfterOutputFrames(frames) => frames.saturating_mul(2),
        DecodeStart::AtSeconds(seconds) => reader.seek_to_seconds(seconds),
    };

    while !core.stop_requested.load(Ordering::Relaxed) {
        packet_samples.clear();
        if !reader.decode_next_packet(&mut packet_samples)? {
            break;
        }
        if packet_samples.is_empty() {
            continue;
        }

        if skip_samples > 0 {
            let drop_count = skip_samples.min(packet_samples.len());
            skip_samples -= drop_count;
            if drop_count == packet_samples.len() {
                continue;
            }
            core.push_samples_blocking(&packet_samples[drop_count..]);
        } else {
            core.push_samples_blocking(&packet_samples);
        }
    }

    Ok(())
}

fn decode_warm_start(
    song: &Song,
    output_rate: u32,
    seconds: f32,
    cancel: &AtomicBool,
) -> Result<Vec<f32>, String> {
    let mut reader = AudioReader::open(Path::new(&song.file_path), output_rate)?;
    let target_samples = ((output_rate as f32 * seconds) as usize).max(1) * 2;
    let mut output = Vec::with_capacity(target_samples);
    let mut packet_samples = Vec::new();

    while output.len() < target_samples && !cancel.load(Ordering::Relaxed) {
        packet_samples.clear();
        if !reader.decode_next_packet(&mut packet_samples)? {
            break;
        }
        let remaining = target_samples - output.len();
        output.extend(packet_samples.iter().take(remaining).copied());
    }

    Ok(output)
}

struct AudioReader {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    source_sample_rate: u32,
    output_sample_rate: u32,
}

impl AudioReader {
    fn open(path: &Path, output_sample_rate: u32) -> Result<Self, String> {
        let file = File::open(path).map_err(|err| err.to_string())?;
        let mss = MediaSourceStream::new(
            Box::new(file),
            MediaSourceStreamOptions {
                buffer_len: MEDIA_BUFFER_LEN,
            },
        );
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
            hint.with_extension(extension);
        }

        let format = symphonia::default::get_probe()
            .probe(
                &hint,
                mss,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|err| err.to_string())?;
        let track = format
            .default_track(TrackType::Audio)
            .ok_or_else(|| "No default audio track found".to_string())?;
        let time_base = track.time_base;
        let codec_params = match &track.codec_params {
            Some(CodecParameters::Audio(params)) => params.clone(),
            _ => return Err("Default track is not an audio track".to_string()),
        };
        let source_sample_rate = codec_params.sample_rate.unwrap_or(output_sample_rate);
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
            .map_err(|err| err.to_string())?;
        let track_id = track.id;

        Ok(Self {
            format,
            decoder,
            track_id,
            time_base,
            source_sample_rate,
            output_sample_rate,
        })
    }

    fn seek_to_seconds(&mut self, seconds: f64) -> usize {
        if seconds <= 0.0 {
            return 0;
        }

        let fallback_frames = (seconds * f64::from(self.output_sample_rate)) as usize;
        let Some(time) = Time::try_from_secs_f64(seconds) else {
            return fallback_frames.saturating_mul(2);
        };

        let seeked = self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time,
                track_id: Some(self.track_id),
            },
        );

        let Ok(seeked) = seeked else {
            return fallback_frames.saturating_mul(2);
        };

        self.decoder.reset();

        let actual_seconds = self
            .time_base
            .and_then(|time_base| time_base.calc_time(seeked.actual_ts))
            .map(|time| time.as_secs_f64())
            .unwrap_or(0.0);
        let trim_seconds = (seconds - actual_seconds).max(0.0);
        let trim_frames = (trim_seconds * f64::from(self.output_sample_rate)) as usize;
        trim_frames.saturating_mul(2)
    }

    fn decode_next_packet(&mut self, output: &mut Vec<f32>) -> Result<bool, String> {
        loop {
            let Some(packet) = self.format.next_packet().map_err(|err| err.to_string())? else {
                return Ok(false);
            };
            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(_) => continue,
            };
            append_stereo_samples(output, decoded)?;
            if self.source_sample_rate != self.output_sample_rate {
                let resampled = resample_stereo_linear(
                    output,
                    self.source_sample_rate,
                    self.output_sample_rate,
                );
                output.clear();
                output.extend(resampled);
            }
            return Ok(true);
        }
    }
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

fn warm_cache_key(song_id: &str, output_rate: u32) -> String {
    format!("{song_id}:{output_rate}")
}

fn validate_playable_file(song: &Song) -> Result<(), String> {
    let file_type = song.file_type.to_ascii_lowercase();
    if matches!(file_type.as_str(), "mp3" | "wav") {
        return Ok(());
    }

    let extension = file_extension(&song.file_path).unwrap_or(file_type);
    if matches!(extension.as_str(), "mp3" | "wav") {
        Ok(())
    } else {
        Err("Only MP3 and WAV playback are supported.".to_string())
    }
}

fn file_extension(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn build_visualizer_frame(
    samples: &[f32],
    sample_rate: u32,
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
    let total_frames = samples.len() / 2;
    let start = total_frames.saturating_sub(FFT_SIZE);
    mono.fill(0.0);
    let mut waveform = Vec::with_capacity(128);
    let mut left_acc = 0.0;
    let mut right_acc = 0.0;
    let mut mono_sum = 0.0;

    for (index, frame_index) in (start..total_frames).enumerate() {
        let left = samples[frame_index * 2];
        let right = samples[frame_index * 2 + 1];
        let mixed = (left + right) * 0.5;
        mono[index] = mixed;
        mono_sum += mixed;
        left_acc += left.abs();
        right_acc += right.abs();
    }

    let sample_count = (total_frames - start).max(1) as f32;
    let dc_offset = mono_sum / sample_count;
    for index in 0..(total_frames - start) {
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

    let frequency_bins = build_log_frequency_bins(fft_buffer, sample_rate, smoothed_bins, peaks);
    let vocal_bins = build_vocal_bins(fft_buffer, sample_rate, smoothed_vocal_bins);
    let raw_bass = normalized_fft_range_energy(fft_buffer, sample_rate, BASS_LOW_HZ, BASS_HIGH_HZ);
    let bass_pulse_value = update_bass_pulse(raw_bass, bass_floor, bass_peak, bass_pulse);
    let max_frequency = visualizer_max_frequency(sample_rate);
    let bass = raw_bass;
    let mids = average_range_by_hz(&frequency_bins, VOCAL_LOW_HZ, VOCAL_HIGH_HZ, max_frequency);
    let treble = average_range_by_hz(&frequency_bins, 4_000.0, 16_000.0, max_frequency);
    let left_level = (left_acc / sample_count).clamp(0.0, 1.0);
    let right_level = (right_acc / sample_count).clamp(0.0, 1.0);
    let volume = ((left_level + right_level) * 0.5).clamp(0.0, 1.0);

    VisualizerFrame {
        timestamp: cursor_frame as f64 / f64::from(sample_rate),
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
