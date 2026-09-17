import { useState } from "react";
import { Check, Edit2, Trash2, X, Plus } from "lucide-react";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import type { ResourcesPageModel } from "../../pages/resources-page-model";
import { COMMON_PROVIDER_PRESETS, findKnownProvider } from "./known-providers";

export function ProviderManagementDialog({ model }: { model: ResourcesPageModel }) {
  const {
    showManageProviders,
    setShowManageProviders,
    providerOptions,
    resources,
    updateProviderMutation,
    deleteProviderMutation,
    createProviderMutation,
    setValue,
    getValues,
  } = model;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [showAddInline, setShowAddInline] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");

  if (!showManageProviders) return null;

  const startEdit = (id: string, currentName: string) => {
    setEditingId(id);
    setEditingName(currentName);
    setConfirmDeleteId(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };

  const saveEdit = (id: string) => {
    if (!editingName.trim()) return;
    updateProviderMutation.mutate(
      { id, name: editingName.trim() },
      {
        onSuccess: () => {
          setEditingId(null);
          setEditingName("");
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteProviderMutation.mutate(id, {
      onSuccess: () => {
        setConfirmDeleteId(null);
        if (getValues("provider_id") === id) {
          setValue("provider_id", "");
        }
      },
    });
  };

  const handleCreate = () => {
    if (!newCode.trim() || !newName.trim()) return;
    const clean = newCode.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    const formattedCode = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "";
    createProviderMutation.mutate(
      {
        code: formattedCode,
        name: newName.trim(),
        base_url: newBaseUrl.trim() || undefined,
      },
      {
        onSuccess: (data) => {
          setShowAddInline(false);
          setNewCode("");
          setNewName("");
          setNewBaseUrl("");
          setValue("provider_id", data.provider.id);
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-ql-border bg-ql-surface p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between pb-3 border-b border-ql-border">
          <div>
            <h3 className="text-[16px] font-semibold text-ql-fg">厂商管理</h3>
            <p className="text-[12px] text-ql-fg-muted mt-0.5">
              管理已添加的上游厂商。无关联资源的厂商可安全删除并释放厂商代码。
            </p>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-ql-fg-muted hover:bg-ql-surface-subtle hover:text-ql-fg"
            onClick={() => {
              setShowManageProviders(false);
              setEditingId(null);
              setConfirmDeleteId(null);
              setShowAddInline(false);
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 厂商列表 */}
        <div className="mt-4 max-h-[60vh] overflow-y-auto space-y-2.5 pr-1">
          {providerOptions.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-ql-fg-muted">
              暂无已添加的厂商
            </div>
          ) : (
            providerOptions.map((provider) => {
              const resourceCount = resources.filter((r) => r.provider_id === provider.id).length;
              const isEditing = editingId === provider.id;
              const isConfirmingDelete = confirmDeleteId === provider.id;

              return (
                <div
                  key={provider.id}
                  className="flex flex-col gap-2 rounded-lg border border-ql-border bg-ql-surface-subtle p-3 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 mr-2">
                      {isEditing ? (
                        <div className="flex items-center gap-1.5 flex-1 max-w-[240px]">
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="w-full px-2 py-1 border border-ql-action rounded text-[13px] bg-ql-surface text-ql-fg focus:outline-none"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveEdit(provider.id);
                              if (e.key === "Escape") cancelEdit();
                            }}
                          />
                          <button
                            type="button"
                            className="p-1 rounded text-ql-action hover:bg-ql-action-soft"
                            onClick={() => saveEdit(provider.id)}
                            disabled={updateProviderMutation.isPending || !editingName.trim()}
                            title="保存"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="p-1 rounded text-ql-fg-muted hover:bg-ql-surface"
                            onClick={cancelEdit}
                            title="取消"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-ql-fg">
                            {provider.name}
                          </span>
                          <span className="rounded bg-ql-surface border border-ql-border px-1.5 py-0.5 text-[11px] font-mono text-ql-fg-secondary">
                            {provider.code}
                          </span>
                          {provider.capability_set && typeof (provider.capability_set as any).base_url === "string" ? (
                            <span
                              className="max-w-[160px] truncate rounded bg-ql-surface border border-ql-border px-1.5 py-0.5 text-[10px] text-ql-fg-muted font-mono"
                              title={(provider.capability_set as any).base_url}
                            >
                              {(provider.capability_set as any).base_url}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>

                    {!isEditing && (
                      <div className="flex items-center gap-1">
                        {isConfirmingDelete ? (
                          <div className="flex items-center gap-1.5 animate-in fade-in duration-150">
                            <span className="text-[12px] text-ql-danger font-medium">确定删除？</span>
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-ql-danger text-white text-[11px] font-medium hover:bg-ql-danger-hover disabled:opacity-60 shadow-sm"
                              onClick={() => handleDelete(provider.id)}
                              disabled={deleteProviderMutation.isPending}
                            >
                              {deleteProviderMutation.isPending ? "删除中…" : "确定"}
                            </button>
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-ql-surface border border-ql-border text-[11px] text-ql-fg hover:bg-ql-surface-subtle"
                              onClick={() => setConfirmDeleteId(null)}
                              disabled={deleteProviderMutation.isPending}
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="flex items-center gap-1 px-2 py-1 rounded text-[12px] text-ql-action hover:bg-ql-action-soft transition-colors"
                              onClick={() => startEdit(provider.id, provider.name)}
                            >
                              <Edit2 className="h-3 w-3" />
                              编辑
                            </button>
                            <button
                              type="button"
                              className={`flex items-center gap-1 px-2 py-1 rounded text-[12px] transition-colors ${
                                resourceCount > 0
                                  ? "text-ql-fg-muted/60 hover:text-ql-danger hover:bg-ql-danger-soft"
                                  : "text-ql-danger hover:bg-ql-danger-soft"
                              }`}
                              onClick={() => setConfirmDeleteId(provider.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-[12px] text-ql-fg-muted pt-1 border-t border-ql-border/50">
                    <span>
                      已关联 <strong className="text-ql-fg">{resourceCount}</strong> 个资源账号
                    </span>
                  </div>

                  {/* 删除二次确认提示 */}
                  {isConfirmingDelete && (
                    <div className="mt-2 rounded border border-ql-danger/30 bg-ql-danger-soft p-2 text-[12px]">
                      {resourceCount > 0 ? (
                        <div>
                          <p className="text-ql-danger font-medium">
                            该厂商名下仍有 {resourceCount} 个绑定的资源账号。
                          </p>
                          <p className="text-ql-fg-muted mt-0.5">
                            为保证路由与审计完整，无法直接删除。请先在资源列表中删除或迁移关联账号。
                          </p>
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              className="px-2.5 py-1 rounded bg-ql-surface border border-ql-border text-[11px] text-ql-fg hover:bg-ql-surface-subtle"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              我知道了
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <p className="text-ql-danger font-medium">
                            确定要删除厂商 “{provider.name} ({provider.code})” 吗？
                          </p>
                          <p className="text-ql-fg-muted mt-0.5">
                            该厂商无关联资源，删除后将释放厂商代码，此操作不可撤销。
                          </p>
                          <div className="mt-2 flex justify-end gap-2">
                            <button
                              type="button"
                              className="px-2.5 py-1 rounded bg-ql-surface border border-ql-border text-[11px] text-ql-fg hover:bg-ql-surface-subtle"
                              onClick={() => setConfirmDeleteId(null)}
                              disabled={deleteProviderMutation.isPending}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="px-2.5 py-1 rounded bg-ql-danger text-white text-[11px] font-medium hover:bg-ql-danger-hover disabled:opacity-60"
                              onClick={() => handleDelete(provider.id)}
                              disabled={deleteProviderMutation.isPending}
                            >
                              {deleteProviderMutation.isPending ? "删除中…" : "确认删除"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 错误提示 */}
        {deleteProviderMutation.error && (
          <p className="mt-3 text-[12px] text-ql-danger" role="alert">
            {deleteProviderMutation.error.message}
          </p>
        )}
        {updateProviderMutation.error && (
          <p className="mt-3 text-[12px] text-ql-danger" role="alert">
            {updateProviderMutation.error.message}
          </p>
        )}

        {/* 快捷新建厂商表单 */}
        {showAddInline ? (
          <div className="mt-4 rounded-lg border border-ql-border bg-ql-surface-subtle p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-medium text-ql-fg">新建厂商</span>
              <span className="text-[11px] text-ql-fg-muted">主流厂商已内置官方协议与接口</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pb-2 mb-2 border-b border-ql-border/50">
              <span className="text-[11px] text-ql-fg-muted mr-1">快捷填入：</span>
              {COMMON_PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.code}
                  type="button"
                  className="inline-flex items-center rounded-md border border-ql-border bg-ql-surface px-2 py-0.5 text-[11px] text-ql-fg-secondary hover:border-ql-action hover:text-ql-action hover:bg-ql-action-soft/40 transition-colors"
                  onClick={() => {
                    setNewCode(preset.code);
                    setNewName(preset.name);
                    setNewBaseUrl(preset.defaultBaseUrl);
                  }}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-3">
              <FormField htmlFor="inline-provider-code" label="厂商代码 (首字母大写)">
                <input
                  className={INPUT_CLASS}
                  id="inline-provider-code"
                  placeholder="如：Qwen 或 Minimax"
                  value={newCode}
                  onChange={(e) => {
                    const clean = e.target.value.replace(/[^a-zA-Z0-9_-]/g, "");
                    const formatted = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "";
                    setNewCode(formatted);
                    const matched = findKnownProvider(formatted);
                    if (matched) {
                      if (!newName) setNewName(matched.name);
                      if (!newBaseUrl) setNewBaseUrl(matched.defaultBaseUrl);
                    }
                  }}
                />
              </FormField>
              <FormField htmlFor="inline-provider-name" label="显示名称">
                <input
                  className={INPUT_CLASS}
                  id="inline-provider-name"
                  placeholder="如：通义千问"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </FormField>
              <FormField htmlFor="inline-provider-base-url" label="接口地址 (Base URL，选填)">
                <input
                  className={INPUT_CLASS}
                  id="inline-provider-base-url"
                  placeholder="官方默认内置，自定义填写如 https://api.openai.com/v1"
                  value={newBaseUrl}
                  onChange={(e) => setNewBaseUrl(e.target.value)}
                />
              </FormField>
            </div>
            {createProviderMutation.error && (
              <p className="mb-2 text-[12px] text-ql-danger">{createProviderMutation.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded-md border border-ql-border px-3 text-[12px] text-ql-fg-secondary hover:bg-ql-surface"
                onClick={() => {
                  setShowAddInline(false);
                  setNewCode("");
                  setNewName("");
                  setNewBaseUrl("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="h-8 rounded-md bg-ql-action px-3 text-[12px] font-medium text-white hover:bg-ql-action-hover disabled:opacity-60"
                disabled={createProviderMutation.isPending || !newCode.trim() || !newName.trim()}
                onClick={handleCreate}
              >
                {createProviderMutation.isPending ? "创建中…" : "确认创建"}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex justify-between items-center border-t border-ql-border pt-3">
            <button
              type="button"
              className="flex items-center gap-1 text-[13px] font-medium text-ql-action hover:underline"
              onClick={() => {
                setShowAddInline(true);
              }}
            >
              <Plus className="h-4 w-4" />
              新建厂商
            </button>
            <button
              type="button"
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[13px] font-medium text-ql-fg hover:bg-ql-surface-subtle"
              onClick={() => {
                setShowManageProviders(false);
                setEditingId(null);
                setConfirmDeleteId(null);
                setShowAddInline(false);
              }}
            >
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
