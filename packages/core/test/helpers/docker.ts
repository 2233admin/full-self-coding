import { spawnSync } from "bun";

/**
 * True when Docker integration tests can run. Set FSC_SKIP_DOCKER_TESTS=1 to skip them even if
 * Docker is installed (CI does this: the native pipeline does not need Docker).
 */
export const dockerAvailable: boolean = (() => {
  if (process.env.FSC_SKIP_DOCKER_TESTS === "1") return false;
  try {
    return spawnSync({ cmd: ["docker", "info"], timeout: 5000 }).exitCode === 0;
  } catch {
    return false;
  }
})();
