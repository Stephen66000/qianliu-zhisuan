/**
 * 通讯录成员表 —— A 方式开通的勾选与单行操作（复选框 / 全选当前页 / 开通按钮）。
 */
import { Users } from "lucide-react";
import type { DirectoryMember } from "../../api/v2-types";
import { maskMobile, maskUserId } from "../../lib/format";
import { StatusTag } from "../dashboard/StatusTag";
import { QueryGate } from "../states/QueryGate";

/** 已开通 = 候选人已存在未归档员工主体（principal_id 与状态同时存在）。 */
export function isActivated(member: DirectoryMember): boolean {
  return member.principal_id !== null && member.principal_status !== null;
}

interface DirectoryMembersTableProps {
  filteredRows: DirectoryMember[];
  selectedPersonIds: Set<string>;
  pageAllSelected: boolean;
  activating: boolean;
  isLoading: boolean;
  error: Error | null;
  onTogglePerson: (personId: string) => void;
  onTogglePage: () => void;
  onActivate: (personId: string) => void;
  onRetry: () => void;
}

export function DirectoryMembersTable({
  filteredRows, selectedPersonIds, pageAllSelected, activating, isLoading, error,
  onTogglePerson, onTogglePage, onActivate, onRetry,
}: DirectoryMembersTableProps) {
  return (
    <QueryGate emptyDescription="配置通讯录来源并执行同步，或上传标准模板。" emptyIcon={Users} emptyTitle="暂无通讯录成员" error={error} isEmpty={filteredRows.length === 0} isLoading={isLoading} onRetry={onRetry}>
      <div className="overflow-x-auto"><table className="w-full text-left text-[12px]"><thead><tr className="border-b border-ql-border text-ql-fg-tertiary">
        <th className="w-8 py-2"><input aria-label="全选当前页" checked={pageAllSelected} onChange={onTogglePage} type="checkbox"/></th>
        <th className="py-2">成员 / 唯一标识</th><th>工号</th><th>部门</th><th>来源</th><th>主体</th><th>接入配置</th><th className="text-right">操作</th></tr></thead><tbody>{filteredRows.map((member) => <tr className="border-b border-ql-border-zone" key={member.person_id}>
          <td className="py-2"><input aria-label={`选择 ${member.name}`} checked={selectedPersonIds.has(member.person_id)} onChange={() => onTogglePerson(member.person_id)} type="checkbox"/></td>
          <td className="py-2">
            <div className="font-medium text-ql-fg">{member.name}</div>
            <div className="text-[11px] text-ql-fg-tertiary">
              {member.external_member_id ? `ID: ${maskUserId(member.external_member_id)}` : ""}
              {member.mobile ? ` · 手机: ${maskMobile(member.mobile)}` : ""}
            </div>
          </td>
          <td>{member.employee_number ?? "—"}</td><td>{member.department_name ?? "待归属"}</td><td>{member.source_type ?? "手工"}</td><td>{member.principal_status ?? "未建立"}</td><td>{member.access_config_status}</td>
          <td className="text-right">{isActivated(member)
            ? <StatusTag tone="success">已开通</StatusTag>
            : <button className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft disabled:opacity-50" disabled={activating} onClick={() => onActivate(member.person_id)} type="button">开通 AI</button>}</td>
        </tr>)}</tbody></table></div>
    </QueryGate>
  );
}
