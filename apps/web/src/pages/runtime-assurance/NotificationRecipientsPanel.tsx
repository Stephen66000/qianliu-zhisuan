import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleAlert,
  Info,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  User,
  X,
} from "lucide-react";
import {
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
  type PersonItem,
  useNotificationRecipients,
  usePeopleList,
  useSaveNotificationRecipients,
  useTestNotification,
} from "../../api/runtime-assurance";

const CATEGORIES: NotificationCategory[] = [
  "SYSTEM_FAILURE",
  "UPSTREAM_RESOURCE",
  "FINANCE_SECURITY",
  "PERSONNEL_ACCOUNT",
];

export function NotificationRecipientsPanel() {
  const recipientsQuery = useNotificationRecipients();
  const peopleQuery = usePeopleList();
  const saveMutation = useSaveNotificationRecipients();
  const testMutation = useTestNotification();

  // Local state for editing selections: map of category -> person IDs
  const [selectedIds, setSelectedIds] = useState<Record<NotificationCategory, string[]>>({
    SYSTEM_FAILURE: [],
    UPSTREAM_RESOURCE: [],
    FINANCE_SECURITY: [],
    PERSONNEL_ACCOUNT: [],
  });

  // Track if user made changes compared to remote
  const [isDirty, setIsDirty] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ personName: string; success: boolean; msg: string } | null>(null);

  // Active dropdown picker: which category is currently picking a person
  const [activePickerCategory, setActivePickerCategory] = useState<NotificationCategory | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const queryVersion = recipientsQuery.dataUpdatedAt || (recipientsQuery.data ? 1 : 0);

  // Populate local state when query finishes
  useEffect(() => {
    if (recipientsQuery.data) {
      setSelectedIds({
        SYSTEM_FAILURE: recipientsQuery.data.SYSTEM_FAILURE.map((p) => p.id),
        UPSTREAM_RESOURCE: recipientsQuery.data.UPSTREAM_RESOURCE.map((p) => p.id),
        FINANCE_SECURITY: recipientsQuery.data.FINANCE_SECURITY.map((p) => p.id),
        PERSONNEL_ACCOUNT: recipientsQuery.data.PERSONNEL_ACCOUNT.map((p) => p.id),
      });
      setIsDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryVersion]);

  // Lookup map of all people
  const peopleMap = useMemo(() => {
    const map = new Map<string, PersonItem>();
    for (const p of peopleQuery.data ?? []) {
      map.set(p.id, p);
    }
    return map;
  }, [peopleQuery.data]);

  // Handle remove person from a category
  const handleRemovePerson = (category: NotificationCategory, personId: string) => {
    setSelectedIds((prev) => ({
      ...prev,
      [category]: prev[category].filter((id) => id !== personId),
    }));
    setIsDirty(true);
    setSaveSuccessMsg(null);
  };

  // Handle add person to a category
  const handleAddPerson = (category: NotificationCategory, personId: string) => {
    setSelectedIds((prev) => ({
      ...prev,
      [category]: [...prev[category], personId],
    }));
    setIsDirty(true);
    setActivePickerCategory(null);
    setSearchQuery("");
    setSaveSuccessMsg(null);
  };

  // Reset to remote state
  const handleReset = () => {
    if (recipientsQuery.data) {
      setSelectedIds({
        SYSTEM_FAILURE: recipientsQuery.data.SYSTEM_FAILURE.map((p) => p.id),
        UPSTREAM_RESOURCE: recipientsQuery.data.UPSTREAM_RESOURCE.map((p) => p.id),
        FINANCE_SECURITY: recipientsQuery.data.FINANCE_SECURITY.map((p) => p.id),
        PERSONNEL_ACCOUNT: recipientsQuery.data.PERSONNEL_ACCOUNT.map((p) => p.id),
      });
      setIsDirty(false);
      setSaveSuccessMsg(null);
      setTestResult(null);
    }
  };

  // Save changes
  const handleSave = async () => {
    try {
      await saveMutation.mutateAsync(selectedIds);
      setIsDirty(false);
      setSaveSuccessMsg("通知人员配置已成功保存并立即生效！");
      setTimeout(() => setSaveSuccessMsg(null), 5000);
    } catch {
      // handled by mutation error state
    }
  };

  // Send test notification
  const handleTest = async (person: PersonItem) => {
    setTestResult(null);
    try {
      await testMutation.mutateAsync(person.id);
      setTestResult({
        personName: person.name,
        success: true,
        msg: `已成功向 ${person.name} 发送测试消息，请在企业微信中查收。`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({
        personName: person.name,
        success: false,
        msg: `向 ${person.name} 发送测试失败：${msg || "请检查企业微信配置或该人员是否绑定 userid"}`,
      });
    }
  };

  if (recipientsQuery.isLoading || peopleQuery.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-ql-fg-tertiary">
        正在加载通知人员配置与通讯录...
      </div>
    );
  }

  if (recipientsQuery.isError) {
    return (
      <div className="rounded-xl border border-ql-danger/20 bg-ql-danger-soft p-5 text-center">
        <CircleAlert className="mx-auto mb-2 h-6 w-6 text-ql-danger" />
        <p className="text-sm font-medium text-ql-danger">加载通知人员配置失败</p>
        <p className="mt-1 text-xs text-ql-fg-secondary">{recipientsQuery.error?.message}</p>
        <button
          className="mt-3 rounded-lg bg-ql-action px-3 py-1.5 text-xs text-white"
          onClick={() => recipientsQuery.refetch()}
          type="button"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* 规则说明与边界提示横幅 */}
      <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-ql-action" />
          <div className="space-y-1.5 text-xs text-ql-fg-secondary">
            <h3 className="text-sm font-semibold text-ql-fg">
              企业微信通知规则与人员绑定规范
            </h3>
            <ul className="grid gap-1.5 pt-1 md:grid-cols-2">
              <li className="flex items-start gap-1.5">
                <span className="font-semibold text-ql-fg">· 灵活选人：</span>
                针对 4 大类异常直接在通讯录选人，各类型人员可相同或不同，支持单选与多选。
              </li>
              <li className="flex items-start gap-1.5">
                <span className="font-semibold text-ql-fg">· 项目专向路由：</span>
                特定项目主体的调用异常，系统将自动直推该项目负责人，不打扰全局管理员。
              </li>
              <li className="flex items-start gap-1.5">
                <span className="font-semibold text-ql-fg">· 员工使用端直推：</span>
                员工客户端填错 Key 或无模型权限等个人问题，直接私推员工本人排查。
              </li>
              <li className="flex items-start gap-1.5">
                <span className="font-semibold text-ql-fg">· 防风暴与免通知：</span>
                上线初期额度超额免通知；相同错误 15 分钟内静默；自愈恢复后发送绿色消警通知。
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* 提示消息 */}
      {saveSuccessMsg && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-xs font-medium text-emerald-800 border border-emerald-200" role="status">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span>{saveSuccessMsg}</span>
        </div>
      )}
      {saveMutation.isError && (
        <div className="flex items-center gap-2 rounded-lg bg-ql-danger-soft p-3 text-xs font-medium text-ql-danger border border-ql-danger/20" role="alert">
          <CircleAlert className="h-4 w-4 shrink-0" />
          <span>保存失败：{saveMutation.error?.message}</span>
        </div>
      )}
      {testResult && (
        <div
          className={`flex items-center justify-between rounded-lg p-3 text-xs font-medium border ${
            testResult.success
              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
              : "bg-ql-danger-soft text-ql-danger border-ql-danger/20"
          }`}
          role="status"
        >
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <CircleAlert className="h-4 w-4 shrink-0 text-ql-danger" />
            )}
            <span>{testResult.msg}</span>
          </div>
          <button
            className="text-ql-fg-tertiary hover:text-ql-fg"
            onClick={() => setTestResult(null)}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 4 大异常类型卡片 */}
      <div className="grid gap-5">
        {CATEGORIES.map((cat, index) => {
          const meta = NOTIFICATION_CATEGORY_META[cat];
          const personIds = selectedIds[cat];
          const isPickerOpen = activePickerCategory === cat;

          // Available people for adding (excluding already assigned to this category)
          const availablePeople = (peopleQuery.data ?? []).filter(
            (p) => !personIds.includes(p.id),
          );
          const filteredPeople = availablePeople.filter((p) => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return (
              p.name.toLowerCase().includes(q) ||
              p.department_label?.toLowerCase().includes(q) ||
              p.wecom_identity?.provider_user_id.toLowerCase().includes(q)
            );
          });

          return (
            <div
              key={cat}
              className="rounded-xl border border-ql-border bg-ql-surface p-5 shadow-sm transition hover:border-ql-border-strong"
            >
              {/* 卡片头部 */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ql-border pb-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ql-surface-muted text-xs font-semibold text-ql-fg">
                    {index + 1}
                  </span>
                  <h4 className="text-[15px] font-semibold text-ql-fg">{meta.title}</h4>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badgeColor}`}
                  >
                    {meta.badge}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs text-ql-fg-tertiary">
                    已选 <span className="font-semibold text-ql-fg">{personIds.length}</span> 人
                  </span>
                </div>
              </div>

              {/* 卡片场景描述 */}
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-ql-fg-secondary">
                <p>{meta.description}</p>
                <p className="text-ql-fg-tertiary">典型事件：{meta.examples}</p>
              </div>

              {/* 已选人员标签列表 */}
              <div className="mt-4 min-h-[48px] rounded-lg bg-ql-surface-subtle p-3">
                {personIds.length === 0 ? (
                  <div className="flex items-center gap-1.5 py-1 text-xs text-ql-fg-tertiary">
                    <AlertTriangle className="h-3.5 w-3.5 text-ql-warning" />
                    <span>暂未指定人员（发生此类异常时将仅在异常中心记录，不推企业微信）</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {personIds.map((id) => {
                      const person = peopleMap.get(id);
                      if (!person) return null;
                      const hasWecom = Boolean(person.wecom_identity?.provider_user_id);

                      return (
                        <div
                          key={id}
                          className="flex items-center gap-2 rounded-lg border border-ql-border bg-ql-surface px-2.5 py-1.5 text-xs shadow-xs"
                        >
                          <div className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5 text-ql-fg-secondary" />
                            <span className="font-medium text-ql-fg">{person.name}</span>
                            {person.department_label && (
                              <span className="text-[11px] text-ql-fg-tertiary">
                                ({person.department_label})
                              </span>
                            )}
                          </div>

                          {/* 企微状态徽标 */}
                          {hasWecom ? (
                            <span
                              className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 font-mono"
                              title={`企业微信 userid: ${person.wecom_identity?.provider_user_id}`}
                            >
                              {person.wecom_identity?.provider_user_id}
                            </span>
                          ) : (
                            <span
                              className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                              title="该人员未配置企微 userid，可能无法接收企微通知"
                            >
                              未配企微ID
                            </span>
                          )}

                          {/* 测试发送按钮 */}
                          <button
                            aria-label={`向 ${person.name} 测试发送企微消息`}
                            className="ml-1 rounded p-1 text-ql-fg-tertiary hover:bg-ql-surface-muted hover:text-ql-action disabled:opacity-50"
                            disabled={testMutation.isPending || !hasWecom}
                            onClick={() => handleTest(person)}
                            title={hasWecom ? "向此人发送测试消息" : "此人未配企微 userid，无法发送"}
                            type="button"
                          >
                            <Send className="h-3 w-3" />
                          </button>

                          {/* 移除按钮 */}
                          <button
                            aria-label={`移除 ${person.name}`}
                            className="rounded p-1 text-ql-fg-tertiary hover:bg-ql-surface-muted hover:text-ql-danger"
                            onClick={() => handleRemovePerson(cat, id)}
                            title="移除此接收人"
                            type="button"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 添加人员触发与下拉 */}
              <div className="relative mt-3">
                {!isPickerOpen ? (
                  <button
                    className="flex items-center gap-1.5 rounded-lg border border-dashed border-ql-border-strong px-3 py-1.5 text-xs font-medium text-ql-action hover:border-ql-action hover:bg-ql-action-subtle/10"
                    onClick={() => {
                      setActivePickerCategory(cat);
                      setSearchQuery("");
                    }}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>添加通知人员</span>
                  </button>
                ) : (
                  <div className="rounded-xl border border-ql-border-strong bg-ql-surface p-3 shadow-lg ring-1 ring-black/5 z-20">
                    <div className="flex items-center justify-between gap-2 pb-2 border-b border-ql-border">
                      <div className="flex items-center gap-2 flex-1">
                        <Search className="h-3.5 w-3.5 text-ql-fg-tertiary" />
                        <input
                          autoFocus
                          className="w-full text-xs text-ql-fg bg-transparent outline-hidden"
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="搜索通讯录人员姓名、部门或企业微信 userid..."
                          value={searchQuery}
                        />
                      </div>
                      <button
                        className="rounded p-1 text-ql-fg-tertiary hover:text-ql-fg"
                        onClick={() => setActivePickerCategory(null)}
                        type="button"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
                      {filteredPeople.length === 0 ? (
                        <div className="py-4 text-center text-xs text-ql-fg-tertiary">
                          {searchQuery ? "未找到匹配的人员" : "通讯录中暂无可选人员"}
                        </div>
                      ) : (
                        filteredPeople.map((person) => {
                          const hasWecom = Boolean(person.wecom_identity?.provider_user_id);
                          return (
                            <button
                              key={person.id}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-left hover:bg-ql-surface-subtle"
                              onClick={() => handleAddPerson(cat, person.id)}
                              type="button"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-ql-fg">{person.name}</span>
                                {person.department_label && (
                                  <span className="text-ql-fg-tertiary text-[11px]">
                                    ({person.department_label})
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {hasWecom ? (
                                  <span className="font-mono text-[10px] text-emerald-700 bg-emerald-50 px-1 rounded">
                                    {person.wecom_identity?.provider_user_id}
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-amber-700 bg-amber-50 px-1 rounded">
                                    未绑企微
                                  </span>
                                )}
                                <span className="text-[11px] text-ql-action">选择</span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部浮动/固定操作栏 */}
      <div className="sticky bottom-0 z-10 flex items-center justify-between rounded-xl border border-ql-border bg-ql-surface/95 px-5 py-3.5 shadow-md backdrop-blur-xs">
        <div className="text-xs text-ql-fg-secondary">
          {isDirty ? (
            <span className="flex items-center gap-1.5 font-medium text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              有未保存的人员配置变更，请点击“保存配置”生效。
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ql-fg-tertiary">
              <Check className="h-4 w-4 text-emerald-600" />
              当前配置已是最新状态。
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {isDirty && (
            <button
              className="flex items-center gap-1.5 rounded-lg border border-ql-border px-3.5 py-2 text-xs font-medium text-ql-fg hover:bg-ql-surface-subtle"
              disabled={saveMutation.isPending}
              onClick={handleReset}
              type="button"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>放弃修改</span>
            </button>
          )}

          <button
            className="flex items-center gap-1.5 rounded-lg bg-ql-action px-5 py-2 text-xs font-medium text-white shadow-xs hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!isDirty || saveMutation.isPending}
            onClick={handleSave}
            type="button"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{saveMutation.isPending ? "正在保存..." : "保存配置"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
