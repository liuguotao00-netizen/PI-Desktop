//! macOS TCC responsibility shim for host-core.
//!
//! A GUI app that spawns host-core directly becomes the TCC responsible
//! process for Accessibility. The child then inherits the app's (often stale)
//! grant instead of using its own. Disclaiming responsibility before exec makes
//! the OS evaluate `pi-desktop-host-core` itself, which is the binary the user
//! authorizes in System Settings.

#[cfg(target_os = "macos")]
fn main() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::ptr;

    let mut args = std::env::args_os().skip(1);
    let Some(program) = args.next() else {
        eprintln!("usage: pi-desktop-host-launcher <program> [args...]");
        std::process::exit(2);
    };
    let program = match CString::new(program.as_bytes()) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("program path contains a NUL byte");
            std::process::exit(2);
        }
    };
    let argv: Vec<CString> = std::iter::once(program.clone())
        .chain(args.map(|arg| CString::new(arg.as_bytes()).unwrap_or_default()))
        .collect();
    let mut argv_ptrs: Vec<*mut libc::c_char> = argv
        .iter()
        .map(|arg| arg.as_ptr() as *mut libc::c_char)
        .collect();
    argv_ptrs.push(ptr::null_mut());

    let env: Vec<CString> = std::env::vars_os()
        .filter_map(|(key, value)| {
            let mut bytes = key.as_bytes().to_vec();
            bytes.push(b'=');
            bytes.extend_from_slice(value.as_bytes());
            CString::new(bytes).ok()
        })
        .collect();
    let mut env_ptrs: Vec<*mut libc::c_char> = env
        .iter()
        .map(|entry| entry.as_ptr() as *mut libc::c_char)
        .collect();
    env_ptrs.push(ptr::null_mut());

    let mut attr: libc::posix_spawnattr_t = ptr::null_mut();
    if unsafe { libc::posix_spawnattr_init(&mut attr) } != 0 {
        eprintln!("posix_spawnattr_init failed");
        std::process::exit(2);
    }
    // Replace this process instead of forking a second one: Electron's pipes,
    // signals and exit observation then belong to host-core directly.
    unsafe { libc::posix_spawnattr_setflags(&mut attr, libc::POSIX_SPAWN_SETEXEC as i16) };

    let symbol = b"responsibility_spawnattrs_setdisclaim\0";
    let disclaim =
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, symbol.as_ptr() as *const libc::c_char) };
    if !disclaim.is_null() {
        let set_disclaim: unsafe extern "C" fn(
            *mut libc::posix_spawnattr_t,
            libc::c_int,
        ) -> libc::c_int = unsafe { std::mem::transmute(disclaim) };
        unsafe { set_disclaim(&mut attr, 1) };
    } else {
        eprintln!("responsibility_spawnattrs_setdisclaim unavailable; keeping inherited TCC responsibility");
    }

    let mut pid: libc::pid_t = 0;
    let result = unsafe {
        libc::posix_spawn(
            &mut pid,
            program.as_ptr() as *mut libc::c_char,
            ptr::null(),
            &attr,
            argv_ptrs.as_ptr(),
            env_ptrs.as_ptr(),
        )
    };
    if result != 0 {
        eprintln!("posix_spawn failed: {result}");
        std::process::exit(127);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("pi-desktop-host-launcher is only used on macOS");
    std::process::exit(2);
}
