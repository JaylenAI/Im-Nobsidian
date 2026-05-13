import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG } from "../types/config.js";
import type { Config } from "../types/config.js";

const CONFIG_FILE = "config.json";
const IM_NOBSIDIAN_DIR = ".im-nobsidian";

export class ConfigManager {
  private config: Config | null = null;

  constructor(private readonly vaultRoot: string) {}

  get configDir(): string {
    return join(this.vaultRoot, IM_NOBSIDIAN_DIR);
  }

  get configPath(): string {
    return join(this.configDir, CONFIG_FILE);
  }

  get dbPath(): string {
    return join(this.configDir, "sync.db");
  }

  async load(): Promise<Config> {
    try {
      const raw = await readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      this.config = ConfigSchema.parse(parsed);
      return this.config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`설정 파일의 JSON 형식이 올바르지 않습니다: ${this.configPath}`);
      }
      if (error instanceof Error && error.name === "ZodError") {
        throw new Error(`설정 파일 검증 실패: ${error.message}`);
      }
      throw new Error(
        `설정 파일을 찾을 수 없습니다: ${this.configPath}\n'im-nobsidian init'을 먼저 실행하세요.`,
      );
    }
  }

  async save(config: Config): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const content = JSON.stringify(config, null, 2);
    await writeFile(this.configPath, content, "utf-8");
    this.config = config;
  }

  async init(params: { token: string; rootPageId: string }): Promise<Config> {
    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: {
        ...DEFAULT_CONFIG.notion,
        token: params.token,
        rootPageId: params.rootPageId,
      },
    };

    await this.save(config);
    await this.ensureGitignore();
    return config;
  }

  getConfig(): Config {
    if (!this.config) {
      throw new Error("설정이 로드되지 않았습니다. load()를 먼저 호출하세요.");
    }
    return this.config;
  }

  private async ensureGitignore(): Promise<void> {
    const gitignorePath = join(this.vaultRoot, ".gitignore");
    const entry = ".im-nobsidian/";

    try {
      const content = await readFile(gitignorePath, "utf-8");
      if (!content.includes(entry)) {
        await writeFile(gitignorePath, `${content.trimEnd()}\n${entry}\n`, "utf-8");
      }
    } catch {
      await writeFile(gitignorePath, `${entry}\n`, "utf-8");
    }
  }

  async isInitialized(): Promise<boolean> {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(this.configPath);
      return true;
    } catch {
      return false;
    }
  }
}
