import { loadDotEnv } from '../config.js';

export class AuthRequiredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        '缺少 Bangumi 访问令牌：请在 .env 中配置 BGM_ACCESS_TOKEN（前往 https://next.bgm.tv/demo/access-token 生成个人令牌）'
    );
    this.name = 'AuthRequiredError';
  }
}

export class TokenExpiredError extends Error {
  constructor(detail?: string) {
    super(
      `Bangumi 访问令牌已过期或无效${detail ? ` (${detail})` : ''}：个人令牌有效期通常为 7 天，请前往 https://next.bgm.tv/demo/access-token 重新生成并更新 .env 中的 BGM_ACCESS_TOKEN`
    );
    this.name = 'TokenExpiredError';
  }
}

export interface TokenProvider {
  getAccessToken(): Promise<string | null>;
  requireAccessToken(): Promise<string>;
}

/**
 * 独立抽象的令牌提供器：当前走 .env 个人令牌，后续可无缝替换为 OAuth 2.0 刷新器。
 */
export class EnvPersonalTokenProvider implements TokenProvider {
  private readonly explicitToken?: string;

  constructor(explicitToken?: string) {
    this.explicitToken = explicitToken;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.explicitToken !== undefined) {
      const t = this.explicitToken.trim();
      return t || null;
    }
    loadDotEnv();
    const envToken = (process.env.BGM_ACCESS_TOKEN ?? '').trim();
    return envToken || null;
  }

  async requireAccessToken(): Promise<string> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new AuthRequiredError();
    }
    return token;
  }
}
