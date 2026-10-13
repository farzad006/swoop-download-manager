//! Standalone test server for manual testing: `cargo run -p swoop-testserver -- 127.0.0.1:8899`
#[tokio::main]
async fn main() {
    let bind = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:8899".into());
    let s = swoop_testserver::spawn_on(&bind).await;
    println!("test server on http://{}/file/<size>?ranges=0|1&rate=&drop=&name=", s.addr);
    tokio::signal::ctrl_c().await.ok();
}
