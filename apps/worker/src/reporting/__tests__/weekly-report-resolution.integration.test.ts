import { Image } from "@napi-rs/canvas";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { WecomAppClient } from "../../runtime-assurance/wecom-client.js";
import { runCompanyWeeklyReport, runPersonalWeeklyReports } from "../report-jobs.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let enterpriseId: string;
let memberPersonId: string;
const memberName = "测试成员";
const targetDate = new Date("2026-09-27T12:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("weekly_report_resolution");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const enterprise = await db.insertInto("enterprise").values({ name: "合成企业",
    timezone: "Asia/Shanghai" }).returning("id").executeTakeFirstOrThrow();
  enterpriseId = enterprise.id;
  const person = await db.insertInto("person").values({ enterprise_id: enterpriseId,
    name: memberName, department_label: "技术部" }).returning("id").executeTakeFirstOrThrow();
  memberPersonId = person.id;
  await db.insertInto("person_external_identity").values({ enterprise_id: enterpriseId,
    person_id: person.id, provider: "WECOM", provider_user_id: "synthetic-member",
    status: "ACTIVE" }).execute();
  await db.insertInto("principal").values({ enterprise_id: enterpriseId,
    person_id: person.id, type: "EMPLOYEE", name: memberName }).execute();
  await db.insertInto("notification_endpoint").values({ provider: "WECOM_APP",
    corp_id: "synthetic-corp", agent_id: "1", secret_ciphertext: "unused-in-test",
    secret_fingerprint: "unused-in-test", status: "ACTIVE" }).execute();
}, 120_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

function captureDecodedSizes() {
  const sizes: Array<[number, number]> = [];
  const decode = Image.prototype.decode;
  vi.spyOn(Image.prototype, "decode").mockImplementation(async function (this: Image) {
    const result = await decode.call(this);
    sizes.push([this.width, this.height]);
    return result;
  });
  return sizes;
}

function pngSize(png: Buffer): [number, number] {
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe("Weekly jobs produce actual 2x images before delivery", () => {
  it("company preview decodes at 1080x1520 and retains the original viewBox", async () => {
    const sizes = captureDecodedSizes();
    const result = await runCompanyWeeklyReport({ db, enterpriseId, kekBase64: "unused",
      targetDate, recipients: [memberName], dryRun: true });
    expect(result.status).toBe("DRY_RUN");
    expect(result.dateRange).toBe("9.21 - 9.27");
    expect(result.svg).toContain('viewBox="0 0 540 760"');
    expect(result.svg).toContain('width="540" height="760"');
    expect(pngSize(result.pngBuffer!)).toEqual([1080, 1520]);
    expect(sizes[0]).toEqual([1080, 1520]);
  });

  it("personal delivery uploads a 1080x1538 image without changing its crop or recipients", async () => {
    const sizes = captureDecodedSizes();
    const upload = vi.spyOn(WecomAppClient.prototype, "uploadMedia").mockResolvedValue("synthetic-media");
    const sendImage = vi.spyOn(WecomAppClient.prototype, "sendImageMessage")
      .mockResolvedValue({ status: "SENT" });
    vi.spyOn(WecomAppClient.prototype, "sendTextMessage").mockResolvedValue({ status: "SENT" });
    const results = await runPersonalWeeklyReports({ db, enterpriseId, kekBase64: "unused",
      targetDate, userPersonId: memberPersonId });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ userName: memberName, status: "SENT", totalTokens: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(pngSize(upload.mock.calls[0]![1])).toEqual([1080, 1538]);
    expect(sizes[0]).toEqual([1080, 1538]);
    expect(sendImage.mock.calls[0]![1]).toEqual(["synthetic-member"]);
    const preview = await runPersonalWeeklyReports({ db, enterpriseId, kekBase64: "unused",
      targetDate, userPersonId: memberPersonId, dryRun: true });
    expect(preview[0]!.svg).toContain('viewBox="47 65 446 635"');
    expect(preview[0]!.svg).toContain('width="540" height="769"');
  });
});
