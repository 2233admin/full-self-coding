
import { expect, test } from "bun:test";
import { DockerInstance, DockerRunStatus } from "../src/dockerInstance";

test("DockerInstance runs echo and captures output", async () => {
    const instance = new DockerInstance();
    const commands = [
        "echo HelloDocker"
    ];
    // Use official node image for shell reliability
    const result = await instance.runCommandsInDocker({
        image: "node:20-alpine",
        commands,
        timeoutSeconds: 30
    });
    if (result.status !== DockerRunStatus.SUCCESS) {
        console.error('Docker error output:', result.error);
    }
    expect(result.status).toBe(DockerRunStatus.SUCCESS);
    expect(result.output).toMatch(/HelloDocker/);
});


test("DockerInstance creates and runs hello world Node.js script", async () => {
    const instance = new DockerInstance();
    const commands = [
            `echo "console.log('Hello, World!')" > /tmp/hello.js`,
        "node /tmp/hello.js"
    ];
    const result = await instance.runCommandsInDocker({
        image: "node:20-alpine",
        commands,
        timeoutSeconds: 30
    });
    if (result.status !== DockerRunStatus.SUCCESS) {
        console.error('Docker error output:', result.error);
    }
    expect(result.status).toBe(DockerRunStatus.SUCCESS);
    expect(result.output).toMatch(/Hello, World!/);
});

test("DockerInstance handles timeout correctly", async () => {
    const instance = new DockerInstance();
    const commands = [
        "sleep 10" // Command that will definitely take longer than the timeout
    ];
    
    // Set an even shorter timeout to ensure it triggers
    const result = await instance.runCommandsInDocker({
        image: "node:20-alpine",
        commands,
        timeoutSeconds: 1 // Very short timeout to trigger timeout status
    });
    
    // Check both status and success flag
    expect(result.status).toBe(DockerRunStatus.TIMEOUT);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout");
});

test("DockerInstance handles command failure correctly", async () => {
    const instance = new DockerInstance();
    const commands = [
        "nonexistentcommand" // Command that doesn't exist
    ];
    const result = await instance.runCommandsInDocker({
        image: "node:20-alpine",
        commands,
        timeoutSeconds: 10
    });
    expect(result.status).toBe(DockerRunStatus.FAILURE);
});