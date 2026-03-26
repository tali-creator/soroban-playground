import express from "express";
import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";

const router = express.Router();

// Helper function to parse cargo build errors and determine appropriate response
function parseCargoError(stdout, stderr, err) {
  const fullOutput = (stdout || '') + '\n' + (stderr || '');

  // Check for timeout
  if (err && err.code === 'ETIMEDOUT') {
    return {
      statusCode: 500,
      userMessage: 'Compilation timed out. Please check your code for infinite loops or complex operations.',
      detailedMessage: fullOutput
    };
  }

  // Check for missing build tools
  if (stderr && (stderr.includes('cargo: command not found') || stderr.includes('rustc: command not found') || stderr.includes('linker') && stderr.includes('not found'))) {
    return {
      statusCode: 500,
      userMessage: 'Build system not available. Please contact support.',
      detailedMessage: fullOutput
    };
  }

  // Check for Rust compilation errors (user's code issues)
  if (stderr && (stderr.includes('error[') || stderr.match(/^\s*error:/m))) {
    // Extract the first error message for user-friendly feedback
    const lines = stderr.split('\n');
    let firstError = 'Unknown compilation error';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('error[') || trimmed.startsWith('error:')) {
        firstError = trimmed;
        break;
      }
    }
    return {
      statusCode: 400,
      userMessage: `Compilation failed: ${firstError}`,
      detailedMessage: fullOutput
    };
  }

  // Default to server error for unexpected cases
  return {
    statusCode: 500,
    userMessage: 'An unexpected error occurred during compilation.',
    detailedMessage: fullOutput
  };
}

router.post("/", async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  // Define a temporary working directory for this compilation
  const tempDir = path.resolve(process.cwd(), ".tmp_compile_" + Date.now());

  try {
    // Scaffold a temp Rust project
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

    // Write Cargo.toml
    const cargoToml = `
[package]
name = "soroban_contract"
version = "0.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = "20.0.0"

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
`;
    await fs.writeFile(path.join(tempDir, "Cargo.toml"), cargoToml);

    // Write the contract code
    await fs.writeFile(path.join(tempDir, "src", "lib.rs"), code);

    // Execute Soroban CLI (or cargo block)
    // Note: In a real server you might queue these or containerize. Here we spawn.
    const command = 'cargo build --target wasm32-unknown-unknown --release';

    exec(command, { cwd: tempDir, timeout: 30000 }, async (err, stdout, stderr) => {
      // Setup cleanup task
      const cleanUp = async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (e) {
          console.error("Failed to clean up:", e);
        }
      };

      if (err) {
        await cleanUp();
        const errorInfo = parseCargoError(stdout, stderr, err);
        console.error('Compilation error details:', errorInfo.detailedMessage); // Log detailed errors for debugging
        return res.status(errorInfo.statusCode).json({ 
          error: errorInfo.userMessage, 
          status: "error",
          details: errorInfo.detailedMessage,
          logs: stderr ? stderr.split('\n').filter(l => l.trim()) : []
        });
      }

      // Check if wasm exists
      const wasmPath = path.join(tempDir, "target", "wasm32-unknown-unknown", "release", "soroban_contract.wasm");
      try {
        const fileStats = await fs.stat(wasmPath);
        // It's built successfully
        await cleanUp();
        return res.json({ 
          success: true, 
          status: "success",
          message: "Contract compiled successfully",
          logs: (stdout + (stderr ? "\n" + stderr : "")).split('\n').filter(l => l.trim()),
          artifact: {
            name: "soroban_contract.wasm",
            sizeBytes: fileStats.size,
            createdAt: fileStats.birthtime
          }
        });
      } catch (e) {
        await cleanUp();
        // Compilation appeared to succeed but no WASM was generated - likely a user code issue
        const errorInfo = {
          statusCode: 400,
          userMessage: 'Compilation succeeded but no WASM artifact was generated. Please check your contract code for issues.',
          detailedMessage: (stdout || '') + '\n' + (stderr || '')
        };
        console.error('WASM generation error details:', errorInfo.detailedMessage);
        return res.status(errorInfo.statusCode).json({ 
          error: errorInfo.userMessage, 
          status: "error",
          details: errorInfo.detailedMessage,
          logs: stderr ? stderr.split('\n').filter(l => l.trim()) : []
        });
      }
    });

  } catch (err) {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (cleanupErr) {}
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

export default router;
