import { useEffect, useState, type FormEvent } from "react";
import {
  useEnterpriseSettings,
  useUpdateEnterpriseSettings,
} from "../../api/v2-hooks";
import { ErrorState } from "../states/ErrorState";
import { LoadingState } from "../states/LoadingState";

const INPUT =
  "ql-input mt-1 w-full rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-sm";

export function EnterpriseSettingsPanel() {
  const query = useEnterpriseSettings();
  const update = useUpdateEnterpriseSettings();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [currency, setCurrency] = useState("CNY");

  useEffect(() => {
    const settings = query.data?.settings;
    if (!settings) return;
    setName(settings.name);
    setContact(settings.management_contact ?? "");
    setEmail(settings.contact_email ?? "");
    setTimezone(settings.timezone);
    setCurrency(settings.default_currency);
  }, [query.data]);

  if (query.isLoading)
    return <LoadingState label="正在读取企业信息…" rows={4} />;
  if (query.error || !query.data) {
    return (
      <ErrorState
        message={query.error?.message ?? "企业信息加载失败"}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const settings = query.data.settings;
  function reset() {
    setName(settings.name);
    setContact(settings.management_contact ?? "");
    setEmail(settings.contact_email ?? "");
    setTimezone(settings.timezone);
    setCurrency(settings.default_currency);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate({
      expected_version: settings.version,
      name: name.trim(),
      management_contact: contact.trim() || null,
      contact_email: email.trim() || null,
      timezone,
      default_currency: currency,
    });
  }

  return (
    <form className="space-y-6" onSubmit={submit}>
      <h2 className="text-lg font-semibold">企业信息</h2>
      <section className="grid gap-5 border-b border-ql-border-zone pb-6 md:grid-cols-[180px_1fr]">
        <h3 className="text-sm font-semibold">基本资料</h3>
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <label className="text-sm text-ql-fg-secondary md:col-span-2">
            企业名称
            <input
              className={INPUT}
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="text-sm text-ql-fg-secondary">
            管理联系人
            <input
              className={INPUT}
              maxLength={128}
              onChange={(event) => setContact(event.target.value)}
              value={contact}
            />
          </label>
          <label className="text-sm text-ql-fg-secondary">
            联系邮箱
            <input
              className={INPUT}
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
        </div>
      </section>
      <section className="grid gap-5 border-b border-ql-border-zone pb-6 md:grid-cols-[180px_1fr]">
        <h3 className="text-sm font-semibold">区域与核算</h3>
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <label className="text-sm text-ql-fg-secondary">
            企业时区
            <select
              className={INPUT}
              onChange={(event) => setTimezone(event.target.value)}
              value={timezone}
            >
              <option value="Asia/Shanghai">Asia/Shanghai</option>
              <option value="Asia/Hong_Kong">Asia/Hong_Kong</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          <label className="text-sm text-ql-fg-secondary">
            默认币种
            <select
              className={INPUT}
              onChange={(event) => setCurrency(event.target.value)}
              value={currency}
            >
              <option value="CNY">人民币 · CNY</option>
              <option value="USD">美元 · USD</option>
              <option value="HKD">港币 · HKD</option>
              <option value="SGD">新加坡元 · SGD</option>
            </select>
          </label>
          <div className="rounded-lg bg-ql-surface-subtle px-3 py-2 text-[13px] text-ql-fg-secondary md:col-span-2">
            修改时区与币种影响后续统计口径，不改写已关闭账单。
          </div>
        </div>
      </section>
      {update.error ? (
        <p className="rounded-lg bg-ql-danger-soft px-3 py-2 text-sm text-ql-danger">
          {update.error.message}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-ql-fg-tertiary">
          {update.isSuccess
            ? "企业信息已保存"
            : `配置版本 v${settings.version}`}
        </span>
        <div className="flex gap-3">
          <button
            className="rounded-lg border border-ql-border-strong px-4 py-2 text-sm"
            onClick={reset}
            type="button"
          >
            取消修改
          </button>
          <button
            className="rounded-lg bg-ql-action px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={!name.trim() || update.isPending}
            type="submit"
          >
            {update.isPending ? "保存中…" : "保存企业信息"}
          </button>
        </div>
      </div>
    </form>
  );
}
