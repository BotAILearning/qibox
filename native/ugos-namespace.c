#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* No setuid bit or host capabilities. Mount proc inside our new PID/user
 * namespaces before writing UID maps: UGOS makes its original proc read-only. */
static volatile sig_atomic_t forwarded_pid;
static void forward(int sig) { if (forwarded_pid > 0) kill(forwarded_pid, sig); }
static void fail(const char *operation) { perror(operation); _exit(1); }
static void write_map(const char *file, const char *value) {
    int fd = open(file, O_WRONLY | O_CLOEXEC);
    if (fd < 0) fail(file);
    size_t size = strlen(value);
    if (write(fd, value, size) != (ssize_t)size) fail(file);
    if (close(fd) != 0) fail(file);
}
static void drop_caps(void) {
    for (int cap = 0; cap < 64; ++cap)
        if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) fail("drop bounding capability");
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) fail("clear ambient capabilities");
    struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, data) != 0) fail("clear capabilities");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no new privileges");
}
static void bind_readonly(const char *source, const char *target) {
    if (mount(source, target, NULL, MS_BIND, NULL) != 0) fail(target);
    if (mount(NULL, target, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL) != 0) fail(target);
}
static int wait_main(pid_t main_pid, int reap_all) {
    int status;
    for (;;) {
        pid_t result = waitpid(reap_all ? -1 : main_pid, &status, 0);
        if (result == -1 && errno == EINTR) continue;
        if (result < 0) fail("waitpid");
        if (result != main_pid) continue;
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    }
}
int main(int argc, char **argv) {
    if (argc < 4 || argv[1][0] != '/' || argv[2][0] != '/' || argv[3][0] != '/' || getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) {
        fputs("Run the native entry as the unprivileged application user.\n", stderr); return 1;
    }
    uid_t uid = getuid(); gid_t gid = getgid();
    struct sigaction action = {0}; action.sa_handler = forward; sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) fail("signal handler");
    if (prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) != 0) fail("parent death signal");
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID) != 0) fail("create native namespaces");
    pid_t init = fork();
    if (init < 0) fail("fork init");
    if (init > 0) { forwarded_pid = init; drop_caps(); return wait_main(init, 0); }
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) fail("init parent death signal");
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) fail("private mount propagation");
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) fail("private proc");
    char mapping[96];
    write_map("/proc/self/setgroups", "deny");
    snprintf(mapping, sizeof(mapping), "%u %u 1\n", uid, uid); write_map("/proc/self/uid_map", mapping);
    snprintf(mapping, sizeof(mapping), "%u %u 1\n", gid, gid); write_map("/proc/self/gid_map", mapping);
    if (getuid() != uid || getgid() != gid) { errno = EPERM; fail("application identity changed"); }
    if (mount(NULL, "/proc", NULL, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) fail("read-only proc");
    int certificates = open("/etc/ssl/certs", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (certificates < 0) fail("system certificates");
    char source[4096];
    if (snprintf(source, sizeof(source), "%s/etc", argv[1]) >= (int)sizeof(source)) { errno = ENAMETOOLONG; fail("native environment"); }
    bind_readonly(source, "/etc");
    snprintf(source, sizeof(source), "/proc/self/fd/%d", certificates);
    bind_readonly(source, "/etc/ssl/certs");
    close(certificates);
    if (snprintf(source, sizeof(source), "%s/usr", argv[1]) >= (int)sizeof(source)) { errno = ENAMETOOLONG; fail("native environment"); }
    bind_readonly(source, "/usr");
    if (mount("tmpfs", "/dev/shm", "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=268435456,mode=1777") != 0) fail("private shared memory");
    pid_t application = fork();
    if (application < 0) fail("fork application");
    if (application == 0) { drop_caps(); execv(argv[2], &argv[2]); fail("native application entry"); }
    forwarded_pid = application; drop_caps();
    /* Reap detached native children. Exiting PID 1 also clears any remaining
     * processes in this PID namespace when the application exits or crashes. */
    return wait_main(application, 1);
}
