/** 管理写接口可公开返回的资源字段；凭证只允许返回指纹与版本。 */
export interface ResourceViewInput {
  id: string;
  provider_id: string;
  name: string;
  mode: string;
  credential_type: string;
  credential_fingerprint: string | null;
  credential_version: number | null;
  status: string;
  upstream_models: string[] | null;
  concurrency_limit: number | null;
  version: number;
  monthly_budget_amount?: string | null;
  monthly_budget_currency?: string | null;
  created_at: Date;
  updated_at: Date;
}
