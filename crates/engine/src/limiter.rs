use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Token-bucket speed limiter. One instance can be shared by every download
/// (global limit) and another held per download.
pub struct RateLimiter {
    rate: AtomicU64,
    state: Mutex<(f64, Instant)>,
}

impl RateLimiter {
    /// `bytes_per_sec == 0` means unlimited.
    pub fn new(bytes_per_sec: u64) -> Self {
        Self { rate: AtomicU64::new(bytes_per_sec), state: Mutex::new((0.0, Instant::now())) }
    }

    pub fn set_rate(&self, bytes_per_sec: u64) {
        self.rate.store(bytes_per_sec, Ordering::Relaxed);
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::Relaxed)
    }

    pub async fn acquire(&self, n: u64) {
        let rate = self.rate();
        if rate == 0 {
            return;
        }
        let wait = {
            let mut st = self.state.lock().unwrap();
            let now = Instant::now();
            let burst = rate as f64; // at most one second of credit
            st.0 = (st.0 + now.duration_since(st.1).as_secs_f64() * rate as f64).min(burst);
            st.1 = now;
            st.0 -= n as f64;
            if st.0 < 0.0 { Some(-st.0 / rate as f64) } else { None }
        };
        if let Some(secs) = wait {
            tokio::time::sleep(Duration::from_secs_f64(secs)).await;
        }
    }
}
