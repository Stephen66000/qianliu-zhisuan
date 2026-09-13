import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationRecipientsPanel } from "./NotificationRecipientsPanel";

const mutateSaveMock = vi.fn();
const mutateTestMock = vi.fn();

const mockPanelRecipients = {
  SYSTEM_FAILURE: [
    {
      id: "person-1",
      name: "张三",
      department_label: "技术部",
      status: "ACTIVE" as const,
      version: 1,
      wecom_identity: {
        id: "w1",
        person_id: "person-1",
        provider: "WECOM" as const,
        provider_user_id: "zhangsan",
        status: "ACTIVE" as const,
      },
      active_project_count: 0,
    },
  ],
  UPSTREAM_RESOURCE: [],
  FINANCE_SECURITY: [],
  PERSONNEL_ACCOUNT: [],
};

const mockPanelPeople = [
  {
    id: "person-1",
    name: "张三",
    department_label: "技术部",
    status: "ACTIVE" as const,
    version: 1,
    wecom_identity: {
      id: "w1",
      person_id: "person-1",
      provider: "WECOM" as const,
      provider_user_id: "zhangsan",
      status: "ACTIVE" as const,
    },
    active_project_count: 0,
  },
  {
    id: "person-2",
    name: "李四",
    department_label: "财务部",
    status: "ACTIVE" as const,
    version: 1,
    wecom_identity: {
      id: "w2",
      person_id: "person-2",
      provider: "WECOM" as const,
      provider_user_id: "lisi",
      status: "ACTIVE" as const,
    },
    active_project_count: 0,
  },
];

vi.mock("../../api/runtime-assurance", () => ({
  useNotificationRecipients: () => ({
    data: mockPanelRecipients,
    isLoading: false,
    isError: false,
    dataUpdatedAt: 1,
    refetch: vi.fn(),
  }),
  usePeopleList: () => ({
    data: mockPanelPeople,
    isLoading: false,
  }),
  useSaveNotificationRecipients: () => ({
    mutateAsync: mutateSaveMock,
    isPending: false,
    isError: false,
  }),
  useTestNotification: () => ({
    mutateAsync: mutateTestMock,
    isPending: false,
  }),
  NOTIFICATION_CATEGORY_META: {
    SYSTEM_FAILURE: {
      title: "系统级故障",
      description: "API 网关崩溃、服务完全不可用、基础设施瘫痪",
      badge: "P0 致命级",
      examples: "网关 502/504、数据库连接池耗尽、核心服务宕机",
      badgeColor: "bg-red-50 text-red-700 border-red-200",
    },
    UPSTREAM_RESOURCE: {
      title: "上游资源故障",
      description: "厂商凭证失效/被封、全线熔断无备用资源、连续调用高频报错",
      badge: "P1 严重级",
      examples: "Key 失效被拒(401/403)、厂商模型全池不可用、连续错误率超阈值",
      badgeColor: "bg-amber-50 text-amber-700 border-amber-200",
    },
    FINANCE_SECURITY: {
      title: "资金与财务异常",
      description: "上游厂商欠费停机、每日对账严重偏差、调用突增/盗刷攻击",
      badge: "P1/P2 财务级",
      examples: "厂商欠费停机(402)、账本对账严重差异、10分钟内调用量暴增10倍",
      badgeColor: "bg-purple-50 text-purple-700 border-purple-200",
    },
    PERSONNEL_ACCOUNT: {
      title: "人员、账号与安全",
      description: "员工离职自动注销 Key、员工账号被系统风控锁定/冻结",
      badge: "P3 安全审计",
      examples: "离职人员凭证已吊销确认、账号异地异常调用锁定",
      badgeColor: "bg-blue-50 text-blue-700 border-blue-200",
    },
  },
}));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NotificationRecipientsPanel />
    </QueryClientProvider>,
  );
}

describe("NotificationRecipientsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染 4 大异常类型卡片及已配置的人员", () => {
    renderPanel();
    expect(screen.getByText("系统级故障")).toBeInTheDocument();
    expect(screen.getByText("上游资源故障")).toBeInTheDocument();
    expect(screen.getByText("资金与财务异常")).toBeInTheDocument();
    expect(screen.getByText("人员、账号与安全")).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("(技术部)")).toBeInTheDocument();
  });

  it("支持移除已选人员并标记有未保存变更", async () => {
    const user = userEvent.setup();
    renderPanel();
    const removeBtn = screen.getByRole("button", { name: "移除 张三" });
    await user.click(removeBtn);
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
    expect(screen.getByText(/有未保存的人员配置变更/)).toBeInTheDocument();
  });

  it("支持搜索并添加新人员", async () => {
    const user = userEvent.setup();
    renderPanel();
    const addButtons = screen.getAllByRole("button", { name: /添加通知人员/ });
    // Click add on UPSTREAM_RESOURCE (second card)
    await user.click(addButtons[1]!);
    expect(screen.getByPlaceholderText(/搜索通讯录人员姓名/)).toBeInTheDocument();
    const selectBtn = screen.getByRole("button", { name: /李四/ });
    await user.click(selectBtn);
    expect(screen.getByText("李四")).toBeInTheDocument();
  });

  it("支持发送测试企微通知", async () => {
    mutateTestMock.mockResolvedValueOnce({ delivery: { id: "d1" } });
    const user = userEvent.setup();
    renderPanel();
    const testBtn = screen.getByRole("button", { name: /向 张三 测试发送企微消息/ });
    await user.click(testBtn);
    expect(mutateTestMock).toHaveBeenCalledWith("person-1");
    expect(await screen.findByText(/已成功向 张三 发送测试消息/)).toBeInTheDocument();
  });

  it("保存配置调用后端接口", async () => {
    mutateSaveMock.mockResolvedValueOnce({ recipients: {} });
    const user = userEvent.setup();
    renderPanel();
    // make a change first
    const removeBtn = screen.getByRole("button", { name: "移除 张三" });
    await user.click(removeBtn);
    const saveBtn = screen.getByRole("button", { name: "保存配置" });
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);
    expect(mutateSaveMock).toHaveBeenCalledWith({
      SYSTEM_FAILURE: [],
      UPSTREAM_RESOURCE: [],
      FINANCE_SECURITY: [],
      PERSONNEL_ACCOUNT: [],
    });
  });
});
