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
        result = await instance.runCommands(commands, 300);
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/HelloDocker/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
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
        result = await instance.runCommands(commands, 30);
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/Hello, World!/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
        }
    }
});

// test("DockerInstance handles timeout correctly using separate functions", async () => {
//     const instance = new DockerInstance();
//     const image = "node:20-alpine";
//     const commands = ["sleep 10"]; // Command that will definitely take longer than the timeout
//     let containerName: string | undefined;
//     let result: any;

//     try {
//         containerName = await instance.startContainer(image);
//         result = await instance.runCommands( commands, 1); // Very short timeout to trigger timeout status
        
//         // Check both status and success flag
//         expect(result.status).toBe(DockerRunStatus.TIMEOUT);
//         expect(result.success).toBe(false);
//         expect(result.error).toContain("Timeout");
//     } finally {
//         if (containerName) {
//             await instance.shutdownContainer();
//         }
//     }
// });

test("DockerInstance handles command failure correctly using separate functions", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    const commands = ["nonexistentcommand"]; // Command that doesn't exist
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(commands, 10);
        expect(result.status).toBe(DockerRunStatus.FAILURE);
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
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

        await instance.shutdownContainer();

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
        result = await instance.runCommands(commands, 300); // Increased timeout to allow for package installation
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/Hello, World!/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
        }
    }
}, 300000);



test("DockerInstance runs hello world on ubuntu_with_node_and_git", async () => {
    const instance = new DockerInstance();
    const image = "ubuntu_with_node_and_git";
    const commands = [
        "apt-get update && apt-get install -y nodejs",
        `echo "console.log('Hello, World!')" > /tmp/hello.js`,
        "node /tmp/hello.js"
    ];
    let containerName: string | undefined;
    let result: any;

    try {
        containerName = await instance.startContainer(image);
        result = await instance.runCommands(commands, 300);
        if (result.status !== DockerRunStatus.SUCCESS) {
            console.error('Docker error output:', result.error);
        }
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
        expect(result.output).toMatch(/Hello, World!/);
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
        }
    }
}, 300000);

test("DockerInstance runs multiple commands in sequence", async () => {
    const instance = new DockerInstance();
    const image = "node:20-alpine";
    let containerName: string | undefined;

    try {
        containerName = await instance.startContainer(image);

        const commands1 = ["echo 'command set 1'", "ls -l"];
        const result1 = await instance.runCommands(commands1, 30);
        if (result1.status !== DockerRunStatus.SUCCESS) {
            console.error("Test error output:", result1.error);
        }
        expect(result1.status).toBe(DockerRunStatus.SUCCESS);
        expect(result1.output).toMatch(/command set 1/);

        const commands2 = ["echo 'command set 2'", "date"];
        const result2 = await instance.runCommands(commands2, 30);
        expect(result2.status).toBe(DockerRunStatus.SUCCESS);
        expect(result2.output).toMatch(/command set 2/);

    } finally {
        if (containerName) {
            await instance.shutdownContainer();
        }
    }
});


test("DockerInstance runs gemini to create hello world", async () => {
    const instance = new DockerInstance();
    const image = "ubuntu_with_node_and_git:latest";
    const commands = [
        "apt-get update",
        "apt-get install -y curl",
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g @google/gemini-cli",
        // "export GEMINI_API_KEY='YOUR_API_KEY'",
        "gemini -p \"write a hello world js script\" --yolo"
    ];
    let containerName: string | undefined;

    try {
        containerName = await instance.startContainer(image);
        const result = await instance.runCommands(commands, 3000);
        expect(result.status).toBe(DockerRunStatus.SUCCESS);
    } finally {
        if (containerName) {
            await instance.shutdownContainer();
                }
            }
        }, 3000000);
        
        test("DockerInstance copies file from container", async () => {
            const instance = new DockerInstance();
            const image = "node:20-alpine";
            const commands = [`echo "Hello from container file" > /tmp/testfile.txt`];
            let containerName: string | undefined;
        
            try {
                containerName = await instance.startContainer(image);
                await instance.runCommands(commands, 30);
                const fileContent = await instance.copyFileFromContainer("/tmp/testfile.txt");
                expect(fileContent).toBe("Hello from container file\n");
            } finally {
                if (containerName) {
                    await instance.shutdownContainer();
                }
            }
        });
        