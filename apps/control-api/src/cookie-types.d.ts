/**
 * @fastify/cookie 类型增强（Q-DEP-1 整改）。
 *
 * 根因：base tsconfig 的 verbatimModuleSyntax + NodeNext 模块解析下，
 * @fastify/cookie 包内 types/index.d.ts 的 declare module 'fastify' 增强
 * 未被 TS 合并到项目编译单元（验证：同内容文件置于 src/ 内可生效；
 * 从 node_modules 经 import/reference 加载则不合并）。
 *
 * 修复：在项目 src 内显式声明 control-api 实际使用的 3 个 cookie 成员
 * （cookies / setCookie / clearCookie），签名精确对照 @fastify/cookie@11.1.2
 * 的 types/index.d.ts。此文件为编译时 module augmentation，无运行时代码。
 *
 * 注意：若后续升级 @fastify/cookie 或新增 cookie API 调用，需同步更新此声明。
 */
export {};

declare module "fastify" {
  interface FastifyRequest {
    cookies: { [cookieName: string]: string | undefined };
  }
  interface FastifyReply {
    setCookie(
      name: string,
      value: string,
      options?: {
        path?: string;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "lax" | "strict" | "none";
        signed?: boolean;
        maxAge?: number;
        domain?: string;
        expires?: Date;
      },
    ): this;
    clearCookie(
      name: string,
      options?: {
        path?: string;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "lax" | "strict" | "none";
      },
    ): this;
  }
}
