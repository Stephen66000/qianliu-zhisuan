import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectoryPanel } from "./DirectoryPanel";

const useDirectoryMembersMock = vi.fn();
const useDirectorySourceMock = vi.fn();
const useDirectoryImportRunMock = vi.fn();
const useDirectoryImportItemsMock = vi.fn();
const saveSource = vi.fn();
const startSync = vi.fn();
const uploadExcel = vi.fn();
const activateMembers = vi.fn();
const activateByList = vi.fn();
const listPreview = vi.fn();
const deleteMember = vi.fn();
const batchDeleteMembers = vi.fn();

vi.mock("../../api/client", () => ({ download: vi.fn() }));
vi.mock("../../api/v2-hooks", () => ({
  useDirectoryMembers: (search: string) => useDirectoryMembersMock(search),
  useDirectorySource: (type: string) => useDirectorySourceMock(type),
  useSaveDirectorySource: () => ({ mutateAsync: saveSource, isPending: false, error: null }),
  useStartDirectorySync: () => ({ mutateAsync: startSync, isPending: false, error: null }),
  useUploadDirectoryExcel: () => ({ mutateAsync: uploadExcel, isPending: false, error: null }),
  useDirectoryImportRun: (id: string | null) => useDirectoryImportRunMock(id),
  useDirectoryImportItems: (id: string | null) => useDirectoryImportItemsMock(id),
  useActivateDirectoryMembers: () => ({ mutateAsync: activateMembers, isPending: false, error: null }),
  useActivateDirectoryMembersByList: () => ({ mutateAsync: activateByList, isPending: false, error: null }),
  useActivateDirectoryListPreview: () => ({ mutateAsync: listPreview, isPending: false, error: null }),
  useDeleteDirectoryMember: () => ({ mutateAsync: deleteMember, isPending: false, error: null }),
  useBatchDeleteDirectoryMembers: () => ({ mutateAsync: batchDeleteMembers, isPending: false, error: null }),
}));

const source = {
  id: "10000000-0000-4000-8000-000000000001",
  type: "WECOM",
  config_fingerprint: "abc123fingerprint",
  status: "ACTIVE",
  cursor: null,
  version: 3,
  updated_at: "2026-08-13T00:00:00.000Z",
};

const activatedMember = {
  person_id: "20000000-0000-4000-8000-000000000001",
  principal_id: "30000000-0000-4000-8000-000000000001",
  name: "张三",
  employee_number: "E-001",
  department_id: null,
  department_name: null,
  source_type: "WECOM",
  external_member_id: "wx-1",
  person_status: "ACTIVE",
  principal_status: "ACTIVE",
  access_config_status: "PENDING",
};
const inactiveMember = {
  person_id: "20000000-0000-4000-8000-000000000002",
  principal_id: null,
  name: "李四",
  employee_number: "E-002",
  department_id: null,
  department_name: "技术部/架构组",
  source_type: "WECOM",
  external_member_id: "wx-2",
  person_status: "ACTIVE",
  principal_status: null,
  access_config_status: "MISSING",
};

describe("W20-02/03 组织通讯录 Web", () => {
  beforeEach(() => {
    useDirectoryMembersMock.mockReset();
    useDirectorySourceMock.mockReset();
    useDirectoryImportRunMock.mockReset();
    useDirectoryImportItemsMock.mockReset();
    saveSource.mockReset();
    startSync.mockReset();
    uploadExcel.mockReset();
    activateMembers.mockReset();
    activateByList.mockReset();
    listPreview.mockReset();
    useDirectoryMembersMock.mockReturnValue({
      data: { items: [activatedMember, inactiveMember], total: 2 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useDirectorySourceMock.mockImplementation((type: string) => ({
      data: { source: type === "WECOM" ? source : null },
      isLoading: false,
      error: null,
    }));
    useDirectoryImportRunMock.mockImplementation((id: string | null) => ({
      data: id ? {
        run: {
          id,
          import_type: "SYNC",
          status: "PARTIAL",
          total_count: 2,
          success_count: 1,
          conflict_count: 1,
          failed_count: 0,
          error_code: null,
          created_at: "2026-08-13T00:00:00.000Z",
          started_at: "2026-08-13T00:00:01.000Z",
          finished_at: "2026-08-13T00:00:02.000Z",
        },
      } : undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }));
    useDirectoryImportItemsMock.mockImplementation((id: string | null) => ({
      data: id ? {
        items: [{
          id: "40000000-0000-4000-8000-000000000001",
          row_number: 3,
          normalized_name: "李四",
          normalized_department: "总部/销售部",
          status: "CONFLICT",
          reason_code: "STABLE_ID_CONFLICT",
          person_id: null,
          principal_id: null,
        }],
        total: 1,
      } : undefined,
      isLoading: false,
      error: null,
    }));
    saveSource.mockResolvedValue({ source });
    startSync.mockResolvedValue({ runId: "50000000-0000-4000-8000-000000000001", status: "QUEUED" });
    uploadExcel.mockResolvedValue({ runId: "60000000-0000-4000-8000-000000000001", status: "QUEUED" });
  });

  it("来源显示已配置状态，Secret 只写且保存成功后清空", async () => {
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    expect(screen.getByRole("heading", { name: "接口同步" })).toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeInTheDocument();
    expect(screen.queryByText(/abc123fingerprint/)).not.toBeInTheDocument();
    const identity = screen.getByRole("textbox", { name: "企业 ID" });
    const secret = screen.getByLabelText("应用 Secret");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("");

    await user.type(identity, "corp-new");
    await user.type(secret, "secret-only-on-write");
    await user.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(saveSource).toHaveBeenCalledWith({
      expected_version: 3,
      status: "ACTIVE",
      config: { corp_id: "corp-new", corp_secret: "secret-only-on-write" },
    }));
    await waitFor(() => expect(secret).toHaveValue(""));
    expect(identity).toHaveValue("");
    expect(screen.queryByText("secret-only-on-write")).not.toBeInTheDocument();
  });

  it("来源未配置时显示「未配置」状态标签", () => {
    useDirectorySourceMock.mockReturnValue({
      data: { source: null },
      isLoading: false,
      error: null,
    });
    render(<DirectoryPanel />);
    expect(screen.getByRole("heading", { name: "接口同步" })).toBeInTheDocument();
    expect(screen.getByText("未配置")).toBeInTheDocument();
    expect(screen.queryByText("已配置")).not.toBeInTheDocument();
  });

  it("部分失败数量和稳定 reason code 可见，成员缺部门明确显示待归属", async () => {
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(screen.getByRole("button", { name: "同步" }));
    await waitFor(() => expect(screen.getByText("PARTIAL")).toBeInTheDocument());
    expect(screen.getByText("共 2 · 成功 1 · 冲突 1 · 失败 0")).toBeInTheDocument();
    expect(screen.getByText("STABLE_ID_CONFLICT")).toBeInTheDocument();
    expect(screen.getByText("待归属")).toBeInTheDocument();
    expect(screen.getByText("PENDING")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "搜索通讯录成员" }), "张三");
    await waitFor(() => expect(useDirectoryMembersMock).toHaveBeenLastCalledWith("张三"));
    expect(screen.queryByRole("button", { name: "新增" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调岗" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停职" })).not.toBeInTheDocument();
  });

  it("只允许选择 .xlsx，上传后进入同一 Run 结果区", async () => {
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    const input = screen.getByLabelText("上传文件");
    expect(input).toHaveAttribute("accept", ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const file = new File(["xlsx"], "directory.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(input, file);
    await waitFor(() => expect(uploadExcel).toHaveBeenCalledWith(file));
    await waitFor(() => expect(useDirectoryImportRunMock).toHaveBeenLastCalledWith("60000000-0000-4000-8000-000000000001"));
  });

  it("A 方式：未开通显示开通按钮、已开通显示标签；勾选后批量开通并确认（Scenario 2.1/2.2）", async () => {
    activateMembers.mockResolvedValue({ activated_count: 1, already_active_count: 1 });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    expect(screen.getByRole("button", { name: "开通 AI" })).toBeInTheDocument();
    expect(screen.getByText("已开通", { selector: "span" })).toBeInTheDocument();

    await user.click(screen.getByLabelText("选择 李四"));
    await user.click(screen.getByLabelText("选择 张三"));
    expect(screen.getByText(/已选择 2 人（其中未开通 1 人）/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "批量开通 AI" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/将为已选 2 名人员建立 AI 员工主体/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认开通" }));
    await waitFor(() => expect(activateMembers).toHaveBeenCalledTimes(1));
    expect(activateMembers).toHaveBeenCalledWith(expect.arrayContaining([
      inactiveMember.person_id, activatedMember.person_id,
    ]));
  });

  it("A 方式：全选当前页与状态筛选联动", async () => {
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(screen.getByLabelText("全选当前页"));
    expect(screen.getByText(/已选择 2 人/)).toBeInTheDocument();
    await user.click(screen.getByLabelText("全选当前页"));
    expect(screen.queryByText(/已选择/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("开通状态筛选"), "inactive");
    expect(screen.getByRole("button", { name: "开通 AI" })).toBeInTheDocument();
    expect(screen.queryByText("已开通", { selector: "span" })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("全选当前页"));
    expect(screen.getByText(/已选择 1 人（其中未开通 1 人）/)).toBeInTheDocument();
  });

  it("单行【开通 AI】直接发起单人开通", async () => {
    activateMembers.mockResolvedValue({ activated_count: 1, already_active_count: 0 });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(screen.getByRole("button", { name: "开通 AI" }));
    await waitFor(() => expect(activateMembers).toHaveBeenCalledWith([inactiveMember.person_id]));
  });

  it("C 方式：上传名单解析展示识别结果，确认开通后未匹配条目明确可见（Scenario 4.1/4.2）", async () => {
    listPreview.mockResolvedValueOnce({ identifiers: ["E-002", "E-404"] });
    activateByList.mockResolvedValueOnce({ activated_count: 1, already_active_count: 0, not_found: ["E-404"] });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(screen.getByRole("button", { name: "上传名单开通 AI" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const input = screen.getByLabelText(/选择名单文件/);
    expect(input).toHaveAttribute("accept", ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const file = new File(["xlsx"], "activation-list.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(input, file);
    await waitFor(() => expect(listPreview).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.getByText(/识别到 2 个标识/)).toBeInTheDocument());
    expect(screen.getByText(/E-002、E-404/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认开通 2 项" }));
    await waitFor(() => expect(activateByList).toHaveBeenCalledWith(["E-002", "E-404"]));
    await waitFor(() => expect(screen.getByText(/新开通 1 人/)).toBeInTheDocument());
    expect(screen.getByText(/E-404/)).toBeInTheDocument();
    expect(screen.getByText(/以下 1 项在通讯录候选库中未找到/)).toBeInTheDocument();
  });
});
