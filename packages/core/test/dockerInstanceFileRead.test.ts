import { expect, test, describe } from "bun:test";
import { spawnSync } from "bun";
import { DockerInstance } from "../src/dockerInstance";

const dockerAvailable = (() => {
  try {
    const r = spawnSync({ cmd: ["docker", "info"], timeout: 5000 });
    return r.exitCode === 0;
  } catch { return false; }
})();

const testDocker = test.skipIf(!dockerAvailable);

testDocker("DockerInstance creates a file, copies it from the container, and reads the content", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    const commands = [`echo "Hello from a file in the container" > /tmp/testfile.txt`];
    let containerName: string | undefined;

    try {
        containerName = await instance.startContainer(image);
        await instance.runCommands(commands, 30);
        const fileContent = await instance.copyFileFromContainer("/tmp/testfile.txt");
        expect(fileContent).toBe("Hello from a file in the container\n");
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
        }
    }
});
