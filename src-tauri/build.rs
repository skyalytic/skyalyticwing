fn main() {
    println!("cargo:rerun-if-env-changed=SKYALYTICWING_EDITION");
    let edition = "community";
    if let Ok(requested) = std::env::var("SKYALYTICWING_EDITION") {
        assert!(requested.is_empty() || requested == edition, "This source tree cannot build another edition");
    }
    println!("cargo:rustc-env=WING_COMPILED_EDITION={}", edition);
    tauri_build::build()
}
