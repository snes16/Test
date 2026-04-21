import type { Browser, BrowserContext, Page } from "playwright";

export interface BrowserManagerOptions {
  headless?: boolean;
  slowMoMs?: number;
  width?: number;
  height?: number;
  cdpUrl?: string;
  preferredPageUrl?: string;
  userDataDir?: string;
  profileDirectory?: string;
  browserChannel?: "chrome" | "msedge" | "chromium";
}

const INTERNAL_SCHEMES = [
  "about:",
  "chrome:",
  "edge:",
  "devtools:",
  "chrome-extension:",
];

function normalizeHost(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isInternalUrl(url: string): boolean {
  const normalized = url.toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

interface PageCandidate {
  context: BrowserContext;
  page: Page;
  score: number;
}

export class BrowserManager {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private attachedOverCdp = false;

  constructor(private readonly options: BrowserManagerOptions = {}) {}

  async start(): Promise<void> {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    }

    const { chromium } = await import("playwright");
    const viewport = {
      width: this.options.width ?? 1440,
      height: this.options.height ?? 920,
    };

    if (this.options.cdpUrl) {
      await this.ensureCdpEndpointReachable(this.options.cdpUrl);
      this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
      this.attachedOverCdp = true;
      const existingContexts = this.browser.contexts();
      this.context = existingContexts.length > 0 ? existingContexts[0] : undefined;
      if (!this.context) {
        throw new Error(
          `Connected to CDP endpoint "${this.options.cdpUrl}" but no browser context is available.`,
        );
      }
      const preferred = this.selectBestPage(
        existingContexts,
        this.options.preferredPageUrl,
      );
      if (preferred) {
        this.context = preferred.context;
        this.page = preferred.page;
      } else {
        const existingPages = this.context.pages();
        this.page = existingPages.length > 0 ? existingPages[0] : await this.context.newPage();
      }
    } else if (this.options.userDataDir) {
      const launchArgs: string[] = [];
      if (this.options.profileDirectory) {
        launchArgs.push(`--profile-directory=${this.options.profileDirectory}`);
      }

      this.context = await chromium.launchPersistentContext(this.options.userDataDir, {
        headless: this.options.headless ?? false,
        slowMo: this.options.slowMoMs ?? 80,
        channel: this.options.browserChannel ?? "chrome",
        viewport,
        args: launchArgs,
      });

      this.browser = this.context.browser() ?? undefined;
      const existing = this.context.pages();
      this.page = existing.length > 0 ? existing[0] : await this.context.newPage();
    } else {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? false,
        slowMo: this.options.slowMoMs ?? 80,
      });

      this.context = await this.browser.newContext({
        viewport,
      });

      this.page = await this.context.newPage();
      await this.page.goto("about:blank", { waitUntil: "domcontentloaded" });
    }
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser page is not initialized. Call start() first.");
    }
    return this.page;
  }

  async ensureActivePage(preferredUrl?: string, forceCreate = false): Promise<Page> {
    if (!forceCreate && this.page && !this.page.isClosed()) {
      return this.page;
    }

    if (!forceCreate && this.attachedOverCdp && this.browser) {
      const selected = this.selectBestPage(this.browser.contexts(), preferredUrl);
      if (selected) {
        this.context = selected.context;
        this.page = selected.page;
        return this.page;
      }
    }

    if (!this.context) {
      throw new Error("Browser context is not initialized.");
    }

    if (!forceCreate) {
      const reusable = this.context
        .pages()
        .find((candidate) => !candidate.isClosed());
      if (reusable) {
        this.page = reusable;
        return this.page;
      }
    }

    this.page = await this.context.newPage();
    return this.page;
  }

  isAttachedOverCdp(): boolean {
    return this.attachedOverCdp;
  }

  getCurrentUrl(): string {
    return this.getPage().url();
  }

  async switchToBestPage(preferredUrl?: string): Promise<{
    switched: boolean;
    currentUrl: string;
    selectedUrl: string;
  }> {
    if (!this.attachedOverCdp || !this.browser) {
      return {
        switched: false,
        currentUrl: this.getCurrentUrl(),
        selectedUrl: this.getCurrentUrl(),
      };
    }

    const selected = this.selectBestPage(this.browser.contexts(), preferredUrl);
    if (!selected) {
      return {
        switched: false,
        currentUrl: this.getCurrentUrl(),
        selectedUrl: this.getCurrentUrl(),
      };
    }

    const currentUrl = this.getCurrentUrl();
    this.context = selected.context;
    this.page = selected.page;
    return {
      switched: currentUrl !== selected.page.url(),
      currentUrl,
      selectedUrl: selected.page.url(),
    };
  }

  async close(): Promise<void> {
    if (this.attachedOverCdp) {
      // Keep the user's own Chrome instance untouched in CDP attach mode.
      return;
    }
    await this.context?.close();
    await this.browser?.close();
  }

  private selectBestPage(
    contexts: BrowserContext[],
    preferredUrl?: string,
  ): PageCandidate | null {
    const preferredHost = normalizeHost(preferredUrl);
    const candidates: PageCandidate[] = [];

    for (const context of contexts) {
      for (const page of context.pages()) {
        candidates.push({
          context,
          page,
          score: this.scorePage(page.url(), preferredHost),
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  private scorePage(url: string, preferredHost: string | null): number {
    let score = 0;
    const host = normalizeHost(url);

    if (preferredHost && host) {
      if (host === preferredHost) {
        score += 100;
      } else if (host.endsWith(preferredHost) || preferredHost.endsWith(host)) {
        score += 60;
      }
    }

    if (!isInternalUrl(url)) {
      score += 20;
    }
    if (url !== "about:blank") {
      score += 5;
    }
    return score;
  }

  private async ensureCdpEndpointReachable(cdpUrl: string): Promise<void> {
    const endpoint = cdpUrl.replace(/\/+$/, "");
    const versionUrl = `${endpoint}/json/version`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      const response = await fetch(versionUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Не удается подключиться к CDP endpoint "${cdpUrl}" (${details}). Сначала запустите Chrome с remote debugging, затем повторите попытку.\n` +
          `Пример:\n` +
          `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\Google\\Chrome\\User Data" --profile-directory="Profile 4"\n` +
          `Проверьте endpoint в браузере: ${versionUrl}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
