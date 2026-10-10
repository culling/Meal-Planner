import robotsParser from "robots-parser";
import type { AppConfig } from "./config";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

type Robots = ReturnType<typeof robotsParser>;

/**
 * Fetches only URLs it is given, one at a time per website, with an identifying User-Agent,
 * after checking robots.txt. Not a crawler: it never follows links.
 */
export class PoliteFetcher {
  private lastRequest = new Map<string, number>();
  private chains = new Map<string, Promise<unknown>>();
  private robots = new Map<string, { at: number; parser: Robots | null }>();

  constructor(private cfg: Pick<AppConfig, "fetchDelayMs" | "userAgent">) {}

  /** Wait so that requests to one host are at least fetchDelayMs apart. */
  private async throttle(host: string): Promise<void> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
      const wait = (this.lastRequest.get(host) ?? 0) + this.cfg.fetchDelayMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest.set(host, Date.now());
    });
    this.chains.set(host, next.catch(() => undefined));
    await next;
  }

  private async raw(url: string, accept: string): Promise<Response> {
    const u = new URL(url);
    await this.throttle(u.host);
    try {
      return await fetch(url, {
        headers: { "user-agent": this.cfg.userAgent, accept },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ImportError(`Couldn't reach ${u.host}: ${(e as Error).message}`);
    }
  }

  private async isAllowed(url: string): Promise<boolean> {
    const u = new URL(url);
    const cached = this.robots.get(u.origin);
    if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.parser ? cached.parser.isAllowed(url, this.cfg.userAgent) !== false : true;
    const res = await this.raw(`${u.origin}/robots.txt`, "text/plain");
    let parser: Robots | null = null;
    if (res.ok) parser = robotsParser(`${u.origin}/robots.txt`, await res.text());
    else if (res.status >= 500) throw new ImportError(`${u.host} robots.txt is unavailable (${res.status}); try again later`);
    this.robots.set(u.origin, { at: Date.now(), parser });
    return parser ? parser.isAllowed(url, this.cfg.userAgent) !== false : true;
  }

  private check(url: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ImportError(`That doesn't look like a URL: ${url}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ImportError("Only http(s) URLs can be imported");
    return u;
  }

  async html(url: string): Promise<string> {
    this.check(url);
    if (!(await this.isAllowed(url))) throw new ImportError("This site's robots.txt asks not to fetch that page, so it was skipped");
    const res = await this.raw(url, "text/html,application/xhtml+xml");
    if (!res.ok) throw new ImportError(`The site answered ${res.status} for that URL`);
    const text = await res.text();
    if (text.length > 8_000_000) throw new ImportError("That page is too large");
    return text;
  }

  async binary(url: string): Promise<Buffer> {
    this.check(url);
    if (!(await this.isAllowed(url))) throw new ImportError("robots.txt disallows fetching that image");
    const res = await this.raw(url, "image/*");
    if (!res.ok) throw new ImportError(`Image download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}
