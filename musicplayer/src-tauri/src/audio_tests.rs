use super::*;

#[test]
fn output_batch_preserves_pcm_cursor_pause_and_completion() {
    let song: Song = serde_json::from_value(serde_json::json!({
        "id": "test", "filePath": "test.wav", "fileName": "test.wav",
        "fileType": "wav", "metadataSource": "test", "dateAdded": "", "playCount": 0
    }))
    .unwrap();
    let core = Arc::new(PlaybackCore::new(song, 48_000));
    core.seed_samples(&[0.8, -0.4, 0.2, -0.6]);
    core.finished.store(true, Ordering::Relaxed);
    let current = Arc::new(Mutex::new(Some(Arc::clone(&core))));
    let cursor = Arc::new(AtomicUsize::new(100));
    let playing = Arc::new(AtomicBool::new(false));
    let volume = Arc::new(AtomicU32::new(0.5f32.to_bits()));
    let mut captured = Vec::new();
    let mut output = [1.0f32; 6];
    write_output_data(
        &mut output,
        2,
        &current,
        &cursor,
        &playing,
        &volume,
        &mut captured,
    );
    assert_eq!(output, [0.0; 6]);
    assert_eq!(cursor.load(Ordering::Relaxed), 100);
    assert_eq!(core.buffered_frames(), 2);
    playing.store(true, Ordering::Relaxed);
    write_output_data(
        &mut output,
        2,
        &current,
        &cursor,
        &playing,
        &volume,
        &mut captured,
    );
    assert_eq!(output, [0.4, -0.2, 0.1, -0.3, 0.0, 0.0]);
    assert_eq!(cursor.load(Ordering::Relaxed), 102);
    assert!(!playing.load(Ordering::Relaxed));
    let mut rolling = Vec::new();
    core.copy_rolling_samples(&mut rolling);
    assert_eq!(rolling, [0.4, -0.2, 0.1, -0.3]);
}

#[test]
fn reused_fft_buffers_preserve_analysis_exactly() {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
    let window = hann_window();
    let mut mono = vec![0.0; FFT_SIZE];
    let mut buffer = Vec::with_capacity(FFT_SIZE);
    for sample_rate in [44_100, 48_000] {
        let mut smoothed = vec![0.0; VISUALIZER_BINS];
        let mut vocal = vec![0.0; VOCAL_BINS];
        let mut peaks = vec![0.0; VISUALIZER_BINS];
        let (mut floor, mut peak, mut pulse) = (0.05, 0.22, 0.0);
        // Consecutive frames exercise smoothing and reuse, including silence,
        // short startup windows, DC, an impulse and a stereo musical signal.
        for case in 0..20 {
            let count = if case == 1 { 127 } else { FFT_SIZE };
            let samples: Vec<f32> = (0..count)
                .flat_map(|i| {
                    let t = i as f32 / sample_rate as f32;
                    match case {
                        0 => [0.0, 0.0],
                        2 => [0.25, 0.25],
                        3 => [if i == 64 { 1.0 } else { 0.0 }, 0.0],
                        _ => [
                            (t * 440.0 * 6.2831855).sin() * 0.4,
                            (t * 80.0 * 6.2831855).sin() * 0.3,
                        ],
                    }
                })
                .collect();
            let expected = reference_frame(
                &samples,
                sample_rate,
                case * FFT_SIZE,
                &mut smoothed.clone(),
                &mut vocal.clone(),
                &mut peaks.clone(),
                &mut floor.clone(),
                &mut peak.clone(),
                &mut pulse.clone(),
                fft.as_ref(),
                &mut vec![0.0; FFT_SIZE],
                &mut Vec::new(),
            );
            let actual = build_visualizer_frame(
                &samples,
                sample_rate,
                case * FFT_SIZE,
                &mut smoothed,
                &mut vocal,
                &mut peaks,
                &mut floor,
                &mut peak,
                &mut pulse,
                fft.as_ref(),
                &mut mono,
                &mut buffer,
                &mut scratch,
                &window,
            );
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
    }
}

// Frozen pre-optimization implementation guards audio analysis fidelity.
fn reference_frame(
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
