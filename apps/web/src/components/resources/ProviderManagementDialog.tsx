import { useState } from "react";
import { Check, Edit2, Trash2, X, Plus } from "lucide-react";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import type { ResourcesPageModel } from "../../pages/resources-page-model";

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
  const [newCode, setNewCode] = useState("deepseek");
  const [newName, setNewName] = useState("");

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
    if (!newName.trim()) return;
    createProviderMutation.mutate(
      { code: newCode, name: newName.trim() },
      {
        onSuccess: (data) => {
          setShowAddInline(false);
          setNewName("");
          setValue("provider_id", data.provider.id);
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-lg rounded-xl border border-ql-border bg-ql-surface p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-providers-title"
      >
        <div className="flex items-center justify-between border-b border-ql-border pb-3">
          <div>
            <h2 id="manage-providers-title" className="text-[16px] font-semibold text-ql-fg">
              厂商管理
            </h2>
            <p className="mt-0.5 text-[12px] text-ql-fg-tertiary">
              管理已添加的上游厂商。无关联资源的厂商可安全删除并释放厂商代码。
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-1.5 text-ql-fg-tertiary hover:bg-ql-surface-subtle hover:text-ql-fg"
            onClick={() => {
              setShowManageProviders(false);
              setEditingId(null);
              setConfirmDeleteId(null);
              setShowAddInline(false);
            }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 厂商列表 */}
        <div className="mt-4 max-h-[360px] overflow-y-auto divide-y divide-ql-border-zone">
          {providerOptions.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ql-fg-tertiary">暂无厂商数据</p>
          ) : (
            providerOptions.map((provider) => {
              const resourceCount = resources.filter((r) => r.provider_id === provider.id).length;
              const isEditing = editingId === provider.id;
              const isConfirmingDelete = confirmDeleteId === provider.id;

              return (
                <div key={provider.id} className="flex items-center justify-between py-3 gap-3">
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <input
                          className={`${INPUT_CLASS} h-8 text-[13px]`}
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(provider.id);
                            if (e.key === "Escape") cancelEdit();
                          }}
                        />
                        <button
                          type="button"
                          className="rounded-md bg-ql-action p-1.5 text-white hover:bg-ql-action-hover disabled:opacity-60"
                          disabled={updateProviderMutation.isPending || !editingName.trim()}
                          onClick={() => saveEdit(provider.id)}
                          title="保存"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-ql-border p-1.5 text-ql-fg-secondary hover:bg-ql-surface-subtle"
                          onClick={cancelEdit}
                          title="取消"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-[13px] text-ql-fg">{provider.name}</span>
                          <span className="rounded bg-ql-surface-subtle px-1.5 py-0.5 text-[11px] font-mono text-ql-fg-secondary">
                            {provider.code}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-ql-fg-tertiary">
                          {resourceCount > 0 ? `已关联 ${resourceCount} 个资源账号` : "暂无关联资源"}
                        </p>
                      </div>
                    )}
                  </div>

                  {!isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={() => startEdit(provider.id, provider.name)}
                      >
                        编辑
                      </button>

                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1">
                          <span className="text-[12px] text-ql-danger">确认删除？</span>
                          <button
                            type="button"
                            className="rounded-md bg-ql-danger px-2 py-1 text-[12px] font-medium text-white hover:bg-ql-danger-hover disabled:opacity-60"
                            disabled={deleteProviderMutation.isPending}
                            onClick={() => handleDelete(provider.id)}
                          >
                            {deleteProviderMutation.isPending ? "删除中…" : "确定"}
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-ql-border px-2 py-1 text-[12px] text-ql-fg-secondary hover:bg-ql-surface-subtle"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={resourceCount > 0 || deleteProviderMutation.isPending}
                          title={resourceCount > 0 ? "名下已有关联资源，需先删除或迁移资源" : "删除厂商"}
                          onClick={() => setConfirmDeleteId(provider.id)}
                        >
                          删除
                        </button>
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
            <div className="text-[13px] font-medium text-ql-fg mb-2">新建厂商</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <FormField htmlFor="inline-provider-code" label="厂商代码">
                <select
                  className={INPUT_CLASS}
                  id="inline-provider-code"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                >
                  <option value="deepseek">deepseek</option>
                  <option value="zhipu">zhipu</option>
                  <option value="kimi">kimi</option>
                </select>
              </FormField>
              <FormField htmlFor="inline-provider-name" label="显示名称">
                <input
                  className={INPUT_CLASS}
                  id="inline-provider-name"
                  placeholder="如：DeepSeek"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
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
                  setNewName("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="h-8 rounded-md bg-ql-action px-3 text-[12px] font-medium text-white hover:bg-ql-action-hover disabled:opacity-60"
                disabled={createProviderMutation.isPending || !newName.trim()}
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
              onClick={() => setShowAddInline(true)}
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
