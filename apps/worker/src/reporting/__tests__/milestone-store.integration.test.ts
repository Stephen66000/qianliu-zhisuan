import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { startRedisContainer } from "@qianliu/testing";
import { RedisMilestoneStore } from "../milestone-store.js";

describe("Redis milestone compatibility receipts",()=>{
  it("parallel or resumed success increments the weekly win count once",async()=>{
    const container=await startRedisContainer(),redis=createClient({url:container.connectionString});
    try{
      await redis.connect();const store=new RedisMilestoneStore(redis);
      await Promise.all(Array.from({length:12},()=>store.recordUserAwardedTop1ThisWeek("tenant","2026-W43","winner")));
      expect(await store.getUserTop1WinCount("tenant","winner")).toBe(1);
      expect(await store.hasUserAwardedTop1ThisWeek("tenant","2026-W43","winner")).toBe(true);
      await store.recordTop1IssuedToday("tenant","2026-10-21");
      expect(await store.hasTop1IssuedToday("tenant","2026-10-21")).toBe(true);
      expect(await store.hasTop1IssuedToday("other","2026-10-21")).toBe(false);
    }finally{if(redis.isOpen)await redis.quit();await container.stop();}
  },60_000);
});
