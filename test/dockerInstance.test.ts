import { expect, test } from "bun:test";
import { spawnSync } from "bun"; // Added this line
import { DockerInstance, DockerRunStatus } from "../src/dockerInstance";

test("DockerInstance runs echo and captures output using separate functions", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    const commands = ["echo HelloDocker"];
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(containerName, commands, 300);
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/HelloDocker/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer(containerName);
        }
    }
});


test("DockerInstance creates and runs hello world Node.js script using separate functions", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    const commands = [
        `echo "console.log('Hello, World!')" > /tmp/hello.js`,
        "node /tmp/hello.js"
    ];
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(containerName, commands, 30);
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/Hello, World!/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer(containerName);
        }
    }
});

test("DockerInstance handles timeout correctly using separate functions", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    const commands = ["sleep 10"]; // Command that will definitely take longer than the timeout
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(containerName, commands, 1); // Very short timeout to trigger timeout status
        
        // Check both status and success flag
        expect(result.status).toBe(DockerRunStatus.TIMEOUT);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Timeout");
    } finally {
        if (containerName) {
            await instance.shutdownContainer(containerName);
        }
    }
});

test("DockerInstance handles command failure correctly using separate functions", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    const commands = ["nonexistentcommand"]; // Command that doesn't exist
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(containerName, commands, 10);
        expect(result.status).toBe(DockerRunStatus.FAILURE);
    } finally {
        if (containerName) {
            await instance.shutdownContainer(containerName);
        }
    }
});

test("DockerInstance shuts down container correctly", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    let containerName: string | undefined;

    try {
        containerName = await instance.startContainer(image);
        expect(containerName).toBeString();

        await instance.shutdownContainer(containerName!);

        // Attempt to inspect the container to ensure it's stopped and removed
        const inspectResult = spawnSync(["docker", "inspect", containerName!]);
        expect(inspectResult.exitCode).not.toBe(0); // Expecting a non-zero exit code if container is not found
    } catch (error) {
        // If an error occurs during startContainer or shutdownContainer, the test should fail
        throw error;
    }
});

test("DockerInstance creates and runs hello world Node.js script in ubuntu_with_node_and_git:latest using separate functions", async () => {
    const instance = new DockerInstance();
    const image = "ubuntu_with_node_and_git:latest";
    const commands = [
        "apt-get update",
        "apt-get install -y nodejs",
        "echo 'console.log(\"Hello, World!\");' > index.js",
        "node index.js"
    ];
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(containerName, commands, 300); // Increased timeout to allow for package installation
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/Hello, World!/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer(containerName);
        }
    }
}, 300000);