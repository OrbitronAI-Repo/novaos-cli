/**
 * MCP Init — Scaffold a new MCP tool server project.
 *
 * Generates: manifest.json, src/index.ts (or .py), Dockerfile,
 * package.json/requirements.txt, .env.example, and health check stub.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assertNameIsNotPath, assertNoPathTraversal } from "./init-path.js";
import { validateMcpManifest } from "./mcp-manifest.js";

export interface McpInitOptions {
  name: string;
  publisher: string;
  language: "typescript" | "python";
  directory: string;
  force: boolean;
}

const MANIFEST_FILENAME = "manifest.json";
const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_PORT = 3000;

function generateManifest(opts: McpInitOptions): string {
  const manifest = {
    schema_version: "2.0",
    name: opts.name,
    publisher: opts.publisher,
    version: "1.0.0",
    language: opts.language,
    description: `MCP tool server: ${opts.name}`,
    author: { name: opts.publisher },
    categories: ["general"],
    tools: [
      {
        name: "hello_world",
        description: "A sample tool that echoes its input",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message to echo" },
          },
          required: ["message"],
        },
      },
    ],
    health_check: {
      path: DEFAULT_HEALTH_PATH,
      interval_seconds: 30,
      timeout_seconds: 5,
      unhealthy_threshold: 3,
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

function generateTypescriptSource(name: string): string {
  return `import { FastMCP } from "fastmcp";
import { z } from "zod";

const server = new FastMCP({ name: "${name}" });

server.addTool({
  name: "hello_world",
  description: "A sample tool that echoes its input",
  parameters: z.object({
    message: z.string().describe("Message to echo"),
  }),
  execute: async (args) => {
    return args.message;
  },
});

server.start({
  transportType: "httpStream",
  httpStream: { port: ${DEFAULT_PORT} },
});
`;
}

function generatePythonSource(name: string): string {
  return `"""${name} — MCP tool server."""

from fastmcp import FastMCP

mcp = FastMCP("${name}")


@mcp.tool()
def hello_world(message: str) -> str:
    """A sample tool that echoes its input."""
    return message


if __name__ == "__main__":
    mcp.run(transport="streamable-http", port=${DEFAULT_PORT})
`;
}

function generateDockerfile(language: "typescript" | "python"): string {
  if (language === "typescript") {
    return `FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE ${DEFAULT_PORT}
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:${DEFAULT_PORT}/health || exit 1

CMD ["bun", "run", "src/index.ts"]
`;
  }

  return `FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE ${DEFAULT_PORT}
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:${DEFAULT_PORT}/health || exit 1

CMD ["python", "src/index.py"]
`;
}

function generatePackageJson(name: string): string {
  const pkg = {
    name: `mcp-server-${name}`,
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "bun run src/index.ts",
      dev: "bun --watch src/index.ts",
    },
    dependencies: {
      fastmcp: "3.34.0",
      zod: "3.25.76",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function generateRequirementsTxt(): string {
  return `fastmcp==3.2.3
`;
}

function generateEnvExample(): string {
  return `# NovaOS MCP Tool Server environment
# Copy to .env and fill in values

# NOVAOS_ENV=sandbox
# NOVAOS_SANDBOX_URL=http://localhost:4000
`;
}

function generateGitignore(): string {
  return `node_modules/
dist/
.env
__pycache__/
*.pyc
`;
}

export function mcpInit(opts: McpInitOptions): void {
  assertNameIsNotPath("mcp", opts.name);
  assertNoPathTraversal(opts.directory);
  const targetDir = path.resolve(opts.directory);

  if (existsSync(path.join(targetDir, MANIFEST_FILENAME)) && !opts.force) {
    throw new Error(
      `${MANIFEST_FILENAME} already exists in ${targetDir}. Use --force to overwrite.`
    );
  }

  mkdirSync(targetDir, { recursive: true });
  mkdirSync(path.join(targetDir, "src"), { recursive: true });

  writeFileSync(path.join(targetDir, MANIFEST_FILENAME), generateManifest(opts));
  const generatedManifest = JSON.parse(generateManifest(opts));
  const validation = validateMcpManifest(generatedManifest);
  if (!validation.valid) {
    const errs = validation.errors?.map((e) => `  ${e.path}: ${e.message}`).join("\n") ?? "";
    throw new Error(`Generated manifest is invalid (template bug):\n${errs}`);
  }

  const sourceFile = opts.language === "typescript" ? "index.ts" : "index.py";
  const sourceContent =
    opts.language === "typescript"
      ? generateTypescriptSource(opts.name)
      : generatePythonSource(opts.name);
  writeFileSync(path.join(targetDir, "src", sourceFile), sourceContent);

  writeFileSync(path.join(targetDir, "Dockerfile"), generateDockerfile(opts.language));

  if (opts.language === "typescript") {
    writeFileSync(path.join(targetDir, "package.json"), generatePackageJson(opts.name));

    const tsTestContent = `import { describe, it, expect } from "bun:test";

describe("MCP Tool Server", () => {
  it("tool response matches MCP schema", () => {
    const response = {
      content: [{ type: "text", text: "test response" }],
    };
    expect(response.content).toBeInstanceOf(Array);
    expect(response.content[0]).toHaveProperty("type");
    expect(response.content[0]).toHaveProperty("text");
  });
});
`;
    writeFileSync(path.join(targetDir, "src", "index.test.ts"), tsTestContent);
  } else {
    writeFileSync(path.join(targetDir, "requirements.txt"), generateRequirementsTxt());

    mkdirSync(path.join(targetDir, "tests"), { recursive: true });
    const pyTestContent = `"""Tests for ${opts.name} MCP tool server."""

def test_tool_response_schema():
    """Verify tool response matches MCP schema."""
    response = {
        "content": [{"type": "text", "text": "test response"}],
    }
    assert isinstance(response["content"], list)
    assert "type" in response["content"][0]
    assert "text" in response["content"][0]
`;
    writeFileSync(path.join(targetDir, "tests", "test_server.py"), pyTestContent);
  }

  writeFileSync(path.join(targetDir, ".env.example"), generateEnvExample());
  writeFileSync(path.join(targetDir, ".gitignore"), generateGitignore());
}
