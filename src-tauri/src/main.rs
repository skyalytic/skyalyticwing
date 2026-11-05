#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    #[cfg(not(target_os = "windows"))]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--wing-cli")) {
        // AppImage CLI must work without a display server or a GTK window.
        let exe = std::env::current_exe().expect("Cannot locate Wing executable");
        let dir = exe.parent().expect("Missing executable directory");
        let mut roots = vec![dir.to_path_buf(), dir.join("../Resources")];
        if cfg!(target_os = "linux") {
            roots.push(dir.join("../lib/SkyalyticWing Community"));
        }
        for root in roots {
            let cli = root.join("_up_/packages/web/bin/skyalyticwing.cjs");
            if !cli.is_file() { continue; }
            let node_name = if cfg!(target_os = "linux") { "skyalyticwing-node" } else { "node" };
            for node in [dir.join(node_name), root.join(node_name)] {
                if !node.is_file() { continue; }
                let mut command = std::process::Command::new(node);
                if cfg!(target_os = "linux") {
                    command.env("PATH", format!("{}:{}", root.join("cli-bin").display(), std::env::var("PATH").unwrap_or_default()));
                }
                let result = command.arg(&cli).args(std::env::args_os().skip(2)).status();
                std::process::exit(result.ok().and_then(|status| status.code()).unwrap_or(1));
            }
        }
        eprintln!("Wing CLI runtime is missing; please repair the installation.");
        std::process::exit(1);
    }
    skyalyticwing_lib::run()
}
