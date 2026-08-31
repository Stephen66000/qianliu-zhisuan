"""仟流智算 2.0 增量原型回归走查。

只操作本地静态原型和合成数据，不连接产品服务、数据库或外部系统。
"""

from __future__ import annotations

import sys

from playwright.sync_api import Page, sync_playwright


DEFAULT_URL = "http://127.0.0.1:9876/%E4%BB%9F%E6%B5%81%E6%99%BA%E7%AE%97-2.0-%E6%A0%87%E5%87%86%E7%89%88%E5%8E%9F%E5%9E%8B.html"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def click_tab(page: Page, group: str, tab: str) -> None:
    page.locator(f'[data-tab-group="{group}"][data-tab="{tab}"]').click()


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1440, "height": 960}, accept_downloads=True)
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error"
            else None,
        )
        page.goto(url, wait_until="networkidle")

        assert page.title() == "仟流智算 2.0 · 1.0 增量升级原型"

        # 1. 1.0 一级导航完整保留，顺序不变。
        expected_nav = [
            "首页看板", "使用主体", "批量模型授权", "厂商资源", "额度规则",
            "用量账本", "经营账单", "运行保障", "管理员", "系统设置",
        ]
        nav_labels = [text.strip() for text in page.locator('[data-testid="primary-nav"] button').all_inner_texts()]
        assert nav_labels == expected_nav
        for nav_id, title in [
            ("nav-dashboard", "首页看板"), ("nav-principals", "使用主体"),
            ("nav-employee-model-rules", "批量模型授权"), ("nav-resources", "厂商资源"),
            ("nav-quota-rules", "额度规则"), ("nav-usage", "用量账本"),
            ("nav-operating-bill", "经营账单"), ("nav-runtime-assurance", "运行保障"),
            ("nav-admins", "管理员"), ("nav-settings", "系统设置"),
        ]:
            page.locator(f"#{nav_id}").click()
            assert page.locator("#pageTitle").inner_text() == title
            assert page.locator(f"#view-{page.locator(f'#{nav_id}').get_attribute('data-view')}").is_visible()

        # 2. 通讯录为单向只读，并自动衔接使用主体和接入配置。
        page.locator("#nav-principals").click()
        click_tab(page, "principals", "directory")
        assert page.get_by_test_id("directory-readonly-badge").inner_text() == "单向只读"
        directory_text = page.get_by_test_id("directory-sync-panel").inner_text()
        assert "企业微信／飞书是人员与组织关系的权威来源" in directory_text
        assert "自动生成使用主体并初始化接入配置" in directory_text
        assert page.locator('[data-external-id="wx_006"] [data-testid="member-principal-binding"]').inner_text() == "待生成"

        page.get_by_test_id("directory-sync-button").click()
        page.wait_for_timeout(700)
        assert "新增使用主体 1 个" in page.get_by_test_id("directory-sync-result").inner_text()
        assert page.locator('[data-external-id="wx_006"] [data-testid="member-principal-binding"]').inner_text() == "已自动生成"
        assert page.locator('[data-external-id="wx_006"] [data-testid="member-access-binding"]').inner_text() == "已自动初始化"
        assert "hidden" not in (page.locator("#generatedPrincipalRow").get_attribute("class") or "")

        page.get_by_test_id("directory-sync-button").click()
        page.wait_for_timeout(700)
        assert "新增 0 个" in page.get_by_test_id("directory-sync-result").inner_text()
        assert page.locator("#generatedPrincipalRow").count() == 1

        # 3. 自动生成后的主体能直接查看具体厂商额度。
        click_tab(page, "principals", "principal-list")
        assert page.locator("#generatedPrincipalRow").is_visible()
        page.locator('#generatedPrincipalRow [data-open-access="顾宁"]').click()
        modal_text = page.locator("#accessModal").inner_text()
        assert "具体额度在每个厂商资源池内设置" in modal_text
        assert "DeepSeek API" in modal_text
        assert "Kimi Coding Plan" in modal_text
        assert "智谱 Coding Plan" in modal_text
        assert page.locator("#accessKeyState").input_value() == "待首次领取"
        assert "主体月额度" in modal_text and "本地剩余" in modal_text
        page.locator("#closeAccess").click()

        # 4. 员工／项目和日／周／月均在用量账本原页面切换。
        page.locator("#nav-usage").click()
        assert page.locator("#usageTokens").inner_text() == "29.0M"
        page.locator("#period-day").click()
        assert page.locator("#usageTokens").inner_text() == "1.2M"
        page.locator("#principal-type-project").click()
        assert page.locator("#usageTokens").inner_text() == "842K"
        assert "仟流图谱知识库" in page.get_by_test_id("principal-usage-table").inner_text()
        page.locator("#period-week").click()
        assert page.locator("#usageTokens").inner_text() == "5.7M"
        page.locator("#period-month").click()
        assert page.locator("#usageTokens").inner_text() == "19.2M"

        # 5. 部门成本回归、月度对账、CSV 导出、轻量采购复盘均在经营账单内。
        page.locator("#nav-operating-bill").click()
        assert "本月买了什么" in page.locator('[data-tab-panel="bill:monthly"]').inner_text()
        assert "¥22,000" in page.locator('[data-tab-panel="bill:monthly"]').inner_text()

        click_tab(page, "bill", "department")
        assert page.get_by_test_id("department-cost-total").inner_text() == "¥19,780"
        department_text = page.get_by_test_id("department-cost-table").inner_text()
        assert "研发中心" in department_text and "产品中心" in department_text and "市场中心" in department_text
        assert "待归属" in department_text

        click_tab(page, "bill", "reconciliation")
        assert page.get_by_test_id("reconciliation-status").inner_text() == "待对账"
        page.get_by_test_id("reconciliation-run-button").click()
        page.wait_for_timeout(800)
        assert page.get_by_test_id("reconciliation-status").inner_text() == "已通过"
        assert page.get_by_test_id("reconciliation-difference-count").inner_text() == "0"

        with page.expect_download() as download_info:
            page.get_by_test_id("billing-export-csv").click()
        download = download_info.value
        assert download.suggested_filename.endswith(".csv")
        assert "已导出" in page.get_by_test_id("export-feedback").inner_text()

        click_tab(page, "bill", "procurement")
        review_text = page.get_by_test_id("procurement-review-section").inner_text()
        assert "采购金额、真实使用、利用率、耗尽与闲置" in review_text
        assert "维持" in review_text and "关注耗尽" in review_text and "利用不足" in review_text
        page.get_by_test_id("procurement-note").fill("下月维持 DeepSeek，调整 Kimi 分配，智谱继续观察。")
        page.get_by_test_id("procurement-save").click()

        # 6. 不把已明确暂缓或无场景的方向塞进 2.0 原型。
        full_html = page.content()
        for forbidden in ("企业坐席", "直连账本", "谷时队列", "开通标准企业", "组织与成员", "审计与设置"):
            assert forbidden not in full_html

        # 7. 移动端无页面级横向溢出，抽屉导航可用。
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.locator("#mobileNavToggle").click()
        assert page.locator("#mainSidebar").is_visible()
        page.locator("#nav-dashboard").click()
        assert not page.locator("body").evaluate("el => el.classList.contains('nav-open')")

        browser.close()

    if errors:
        raise AssertionError("\n".join(errors))
    print("PASS: 10 项 1.0 导航、通讯录自动衔接、周期用量、部门成本、对账导出、采购复盘与移动端走查全部通过。")


if __name__ == "__main__":
    main()
