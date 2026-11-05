use tauri::Manager;

pub const NAME: &str = env!("WING_COMPILED_EDITION");
pub fn port() -> u16 {
    19111
}
pub fn configure(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (identifier, directory) = match NAME {
        "community" => ("com.skyalyticwing.community", "SkyalyticWingCommunity"),
        "enterprise" => ("com.skyalyticwing.enterprise", "SkyalyticWingEnterprise"),
        _ => return Ok(()),
    };
    if app.config().identifier != identifier { return Err("Desktop edition and application identity do not match".into()); }
    let base = std::env::var_os("SKYALYTICWING_PROFILE_ROOT").map(std::path::PathBuf::from).unwrap_or(app.path().config_dir()?);
    let data = base.join(directory);
    std::fs::create_dir_all(&data)?;
    std::env::set_var("SKYALYTICWING_EDITION", NAME);
    std::env::set_var("SKYALYTICWING_DATA_DIR", &data);
    std::env::set_var("SKYALYTICWING_WEB_DATA_DIR", data.join("web"));
    // Stale environment from another installation must never select its local API.
    std::env::remove_var("SKYALYTICCLAW_DATA_DIR");
    std::env::remove_var("SKYALYTICWING_SKILLS_DIR");
    Ok(())
}
