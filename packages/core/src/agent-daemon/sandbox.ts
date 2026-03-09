/**
 * FSC Sandbox — bubblewrap (bwrap) 进程隔离层
 *
 * 用 Linux namespace 隔离替代 Docker：
 * - PID namespace: 进程互不可见
 * - Mount namespace: 只暴露必要目录
 * - Network: 可选隔离
 * - 零内存开销，启动 <10ms
 *
 * 依赖: apt install bubblewrap
 */

export interface SandboxConfig {
  /** 工作目录 (会挂载为 /workspace) */
  workDir: string;
  /** 是否允许网络访问 (默认 true，Agent 需要调 API) */
  allowNetwork?: boolean;
  /** 额外的只读挂载 [host, container] */
  readonlyBinds?: [string, string][];
  /** 额外的读写挂载 [host, container] */
  readwriteBinds?: [string, string][];
  /** 内存限制 MB (通过 cgroup，需 root) */
  memoryLimitMB?: number;
  /** 超时秒数 */
  timeoutSeconds?: number;
  /** 环境变量 */
  env?: Record<string, string>;
}

const DEFAULT_CONFIG: Partial<SandboxConfig> = {
  allowNetwork: true,
  timeoutSeconds: 300,
};

/**
 * 构建 bwrap 命令行参数
 *
 * 策略: 最小权限原则
 * - /usr, /lib, /lib64, /bin, /sbin: 只读 (系统工具)
 * - /etc: 只读 (DNS, SSL 证书等)
 * - /proc, /dev: 最小化
 * - /tmp: 隔离的 tmpfs
 * - /workspace: 读写 (工作目录)
 * - HOME: 指向 /workspace
 */
export function buildBwrapArgs(config: SandboxConfig): string[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const args: string[] = [
    "bwrap",
    // 进程隔离
    "--unshare-pid",
    "--unshare-ipc",
    // 新的 mount namespace
    "--unshare-uts",
    // 最小化 /proc
    "--proc", "/proc",
    // 最小化 /dev
    "--dev", "/dev",
    // 隔离的 /tmp
    "--tmpfs", "/tmp",
    // 系统目录只读
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/etc", "/etc",
  ];

  // /lib 和 /lib64 可能是符号链接，检查后绑定
  args.push("--ro-bind-try", "/lib", "/lib");
  args.push("--ro-bind-try", "/lib64", "/lib64");
  args.push("--ro-bind-try", "/lib32", "/lib32");

  // bun 运行时
  args.push("--ro-bind-try", "/root/.bun", "/root/.bun");

  // git/ssh (系统路径，不被 /workspace 覆盖)
  args.push("--ro-bind-try", "/root/.ssh", "/root/.ssh");

  // 网络隔离 (不共享网络 namespace = 无网络)
  if (!cfg.allowNetwork) {
    args.push("--unshare-net");
  }

  // 工作目录 (读写) — 必须在 /workspace 子路径挂载之前
  args.push("--bind", cfg.workDir, "/workspace");

  // git credentials 挂载到 HOME=/workspace 下 (必须在 --bind /workspace 之后)
  args.push("--ro-bind-try", "/root/.gitconfig", "/workspace/.gitconfig");
  args.push("--ro-bind-try", "/root/.git-credentials", "/workspace/.git-credentials");

  // 额外只读挂载
  if (cfg.readonlyBinds) {
    for (const [host, container] of cfg.readonlyBinds) {
      args.push("--ro-bind", host, container);
    }
  }

  // 额外读写挂载
  if (cfg.readwriteBinds) {
    for (const [host, container] of cfg.readwriteBinds) {
      args.push("--bind", host, container);
    }
  }

  // 环境
  args.push("--setenv", "HOME", "/workspace");
  args.push("--setenv", "PATH", "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin");
  args.push("--setenv", "LANG", "C.UTF-8");

  if (cfg.env) {
    for (const [key, value] of Object.entries(cfg.env)) {
      args.push("--setenv", key, value);
    }
  }

  // 工作目录
  args.push("--chdir", "/workspace");

  // die-with-parent: 父进程死了子进程也死
  args.push("--die-with-parent");

  return args;
}

/**
 * 在 bubblewrap 沙箱中执行命令
 * @param stdin 可选，通过 pipe 传入 stdin（用于 write_file/edit_file 避免 shell 转义）
 */
export async function execInSandbox(
  command: string,
  config: SandboxConfig,
  stdin?: string,
): Promise<{ output: string; success: boolean; exitCode: number }> {
  const bwrapArgs = buildBwrapArgs(config);
  const fullCmd = [...bwrapArgs, "/usr/bin/bash", "-c", command];

  try {
    const proc = Bun.spawn(fullCmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
    });

    // 写入 stdin 并关闭 (Bun API: stdin 是 FileSink)
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    const timeoutMs = (config.timeoutSeconds || 300) * 1000;
    const timeout = setTimeout(() => proc.kill(), timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    return {
      output: stdout + (stderr ? `\n[stderr] ${stderr}` : ""),
      success: exitCode === 0,
      exitCode,
    };
  } catch (e: any) {
    return { output: e.message, success: false, exitCode: -1 };
  }
}

/**
 * 检测 bwrap 是否可用
 */
export async function checkSandboxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
