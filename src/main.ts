#!/usr/bin/env bun

import analyzeCodebase from "./analyzer";
import { TaskSolverManager } from "./taskSolverManager";
import { createConfig, type Config } from './config';
import { readConfigWithEnv } from './configReader';
import { getGitRemoteUrls } from './utils/git'; // New import

import type { Task } from './task';

// Global configuration accessible throughout the application
export let appConfig: Config;

export async function main(): Promise<void> {

    // Load configuration from standard location with environment variable overrides
    let config: Config;

    const configFilePathIndex = process.argv.indexOf('--config');
    if (configFilePathIndex > -1) {
        // Support legacy --config argument for backwards compatibility
        const configFilePath = process.argv[configFilePathIndex + 1];
        if (configFilePath) {
            try {
                const configFileContent = await Bun.file(configFilePath).text();
                const userConfig = JSON.parse(configFileContent);
                config = createConfig(userConfig);
                console.log(`Loaded configuration from ${configFilePath}`);
            } catch (error) {
                console.error(`Error loading or parsing config file at ${configFilePath}:`, error);
                process.exit(1);
            }
        } else {
            console.error('Error: --config argument requires a path to a configuration file.');
            process.exit(1);
        }
    } else {
        // Use ConfigReader to load from standard location with env var support
        try {
            config = readConfigWithEnv();
            console.log('Loaded configuration from ~/.config/full-self-coding/config.json');
        } catch (error) {
            console.error('Error loading configuration:', error);
            process.exit(1);
        }
    }

    // Store configuration globally for later use
    appConfig = config;

    // Log key configuration details
    console.log('Configuration loaded:');
    console.log(`  Agent Type: ${config.agentType}`);
    console.log(`  Max Docker Containers: ${config.maxDockerContainers}`);
    console.log(`  Docker Image: ${config.dockerImageRef}`);
    console.log(`  Work Style: ${config.workStyle}`);

    let gitRemoteUrl: string;
    try {
        const { fetchUrl } = await getGitRemoteUrls();
        gitRemoteUrl = fetchUrl || ''; // Use fetchUrl, or empty string if not found
        //console.log(`fetchUrl: ${fetchUrl}`);
        if (!gitRemoteUrl) {
            throw new Error("Could not determine git remote URL.");
        }
        console.log(`Detected Git remote URL: ${gitRemoteUrl}`);
    } catch (error) {
        console.error("Error getting git remote URL:", error);
        process.exit(1);
    }

    // // Step 1: analyze the codebase and get tasks
    // const tasks: Task[] = await analyzeCodebase(config, gitRemoteUrl);
    // for (const task of tasks) {
    //     console.log(`Task: ${task.description}`);
    // }

    // Step 2: execute tasks based on analysis
    
    const taskSolverManager = new TaskSolverManager(config, gitRemoteUrl);
    for (const task of tasksList) {
        taskSolverManager.addTask(task);
    }
    await taskSolverManager.start();
}

// Call the main function if this file is run directly
if (import.meta.main) {
    main().catch(console.error);
}


const tasksList: Task[] = 
[
    {
        "title": "Fix Critical Relocation Handlers in Architecture-Specific Linkers",
        "description": "Implement missing relocation type handlers in i386-link.c:319, x86_64-link.c:397, and riscv64-link.c:375. These files currently have 'FIXME: handle reloc type' errors that cause linking failures for certain code patterns. Task involves: 1) Analyzing the unhandled relocation types in each architecture, 2) Implementing the missing relocation handling logic, 3) Adding proper error handling for unsupported relocations, 4) Testing with various code patterns that trigger these relocations, 5) Ensuring compatibility across different object file formats.",
        "priority": 5,
        "ID": "TASK-001"
    },

    {
        "title": "Eliminate Global State in libtcc.c by Refactoring tcc_state",
        "description": "Remove or properly encapsulate the global variable 'tcc_state' marked as 'XXX: get rid of this ASAP' in libtcc.c:72. This global state prevents the library from being truly reentrant. Task involves: 1) Analyzing current usage patterns of tcc_state throughout the codebase, 2) Designing a thread-safe state management approach, 3) Refactoring all code that accesses the global state, 4) Implementing proper context passing mechanisms, 5) Ensuring libtcc becomes fully reentrant except during compilation stage, 6) Adding comprehensive tests for multi-threading scenarios.",
        "priority": 4,
        "ID": "TASK-002"
    },
    {
        "title": "Implement Proper Endianness Handling for IEEE Floating-Point Operations",
        "description": "Fix endianness-dependent code in tccgen.c:317, tccasm.c:563, and tccasm.c:639 where comments indicate 'XXX: endianness dependent' for IEEE floating-point functions. Task involves: 1) Identifying all endianness-dependent floating-point operations, 2) Implementing portable endianness detection and conversion functions, 3) Refactoring IEEE 754 floating-point handling to work correctly on both little-endian and big-endian systems, 4) Adding comprehensive tests on different architectures, 5) Ensuring floating-point accuracy is maintained across platforms.",
        "priority": 4,
        "ID": "TASK-003"
    },
    {
        "title": "Implement Missing ARM Assembly Instructions and Constraints",
        "description": "Complete ARM assembly support by implementing numerous ARM assembly instructions currently marked as 'not implemented' in arm-asm.c and similar issues in riscv64-asm.c:239. Task involves: 1) Cataloging all missing ARM assembly instructions and their encoding formats, 2) Implementing instruction parsing and generation logic for each missing instruction, 3) Adding proper operand validation and constraint checking, 4) Testing with real ARM assembly code that uses these instructions, 5) Ensuring compatibility with ARM and AArch64 architectures, 6) Updating documentation for newly supported instructions.",
        "priority": 4,
        "ID": "TASK-004"
    },
    {
        "title": "Implement C99 Complex Number Type (_Complex) Support",
        "description": "Add support for C99 complex numbers which currently shows '_Complex is not yet supported' error in tccgen.c:4781. Task involves: 1) Adding complex type definitions to the type system, 2) Implementing complex number parsing and semantic analysis, 3) Adding code generation for complex arithmetic operations, 4) Implementing complex number library functions (creal, cimag, etc.), 5) Adding proper type checking for complex expressions, 6) Creating comprehensive tests for complex number functionality, 7) Ensuring compatibility with GCC's complex number implementation.",
        "priority": 3,
        "ID": "TASK-005"
    },
    {
        "title": "Add Thread-Local Storage (_Thread_local) Support",
        "description": "Implement thread-local storage support which currently shows '_Thread_local is not implemented' in tccgen.c:4912. Task involves: 1) Adding thread-local storage specifier to the grammar, 2) Implementing TLS model detection and selection, 3) Adding code generation for TLS variables across different architectures, 4) Implementing runtime support for TLS access, 5) Adding proper section handling for TLS variables in object files, 6) Testing with multi-threaded programs that use thread-local variables, 7) Ensuring compatibility with GCC's TLS implementation.",
        "priority": 3,
        "ID": "TASK-006"
    },
    {
        "title": "Optimize Performance Bottlenecks in COFF File Operations",
        "description": "Address performance issues marked as 'XXX: slow!' in COFF file handling at tcccoff.c:279 and tcccoff.c:455. Task involves: 1) Profiling COFF file parsing operations to identify bottlenecks, 2) Optimizing symbol table and relocation processing, 3) Implementing more efficient data structures for COFF handling, 4) Adding caching mechanisms for frequently accessed data, 5) Reducing memory allocations during COFF processing, 6) Benchmarking performance improvements with various COFF files, 7) Ensuring optimization doesn't break compatibility with different COFF variants.",
        "priority": 3,
        "ID": "TASK-007"
    },
    {
        "title": "Improve Cross-Platform Compatibility by Fixing Integer Size Assumptions",
        "description": "Fix portability issues identified in TODO where code assumes int is 32-bit and uses int when size_t would be more appropriate. Task involves: 1) Auditing entire codebase for integer size assumptions, 2) Replacing inappropriate int usage with properly sized integer types (int32_t, size_t, etc.), 3) Adding compile-time checks for integer size assumptions, 4) Updating APIs to use appropriate types for different platforms, 5) Testing on platforms with different integer sizes (64-bit systems, embedded systems), 6) Ensuring no regressions in performance or functionality.",
        "priority": 2,
        "ID": "TASK-008"
    },
    {
        "title": "Complete Error Handling and User Feedback in Assembler",
        "description": "Implement proper error handling for multiple 'TODO: unimplemented' features in the assembler at tccasm.c:965 and tccasm.c:969. Task involves: 1) Identifying all unimplemented assembler features that currently fail silently, 2) Adding comprehensive error messages with clear explanations, 3) Implementing graceful error recovery where possible, 4) Adding suggestions to users when features are not supported, 5) Creating a comprehensive error code system, 6) Adding tests to verify proper error handling, 7) Documenting all supported and unsupported assembler features.",
        "priority": 2,
        "ID": "TASK-009"
    },
    {
        "title": "Add Comprehensive Test Coverage for Missing Features and Optimizations",
        "description": "Expand test coverage as identified in TODO issues 66-70, focusing on missing optimization tests and performance improvements. Task involves: 1) Analyzing existing test suite to identify gaps in coverage, 2) Creating tests for edge cases in compilation and code generation, 3) Adding performance regression tests to catch optimization regressions, 4) Creating tests for C99 features that are partially implemented, 5) Adding cross-architecture compatibility tests, 6) Implementing automated testing for multiple target architectures, 7) Creating benchmarks to measure compilation speed improvements, 8) Setting up continuous integration for comprehensive testing.",
        "priority": 2,
        "ID": "TASK-010"
    }
];