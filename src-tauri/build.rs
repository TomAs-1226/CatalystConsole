use std::path::Path;

fn main() {
    // The frontend imports three and the interface font from src/vendor, which `npm run vendor`
    // copies out of node_modules and git does not track. A build made without that step compiles,
    // installs and opens a black window: the first import fails and nothing after it runs. That is
    // what v2.0.0's release was, on every computer but the one it was written on. Stop here instead.
    let vendor = Path::new("../src/vendor");
    for file in ["three.module.min.js", "fonts/figtree-latin-wght-normal.woff2"] {
        let path = vendor.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.is_file() {
            panic!(
                "src/vendor/{file} is missing, so this build would open a black window. \
                 Run `npm install` and `npm run vendor` first."
            );
        }
    }

    tauri_build::build()
}
