import { describe, it, expect, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

function createClient() {
  return new NotionClient({ token: "ntn_test_fake_token", concurrency: 1, timeoutMs: 1000 });
}

// 내부 SDK 클라이언트의 fileUploads 를 교체해 네트워크 없이 호출 형태를 검증한다.
function stubFileUploads(client: NotionClient) {
  const create = vi.fn().mockResolvedValue({ id: "upload-1" });
  const send = vi.fn().mockResolvedValue({ status: "pending" });
  const complete = vi.fn().mockResolvedValue({ status: "uploaded" });
  (client as any).client.fileUploads = { create, send, complete };
  return { create, send, complete };
}

function blobOfSize(bytes: number): Blob {
  // 실 데이터 대신 크기만 흉내 — send 는 slice 결과를 그대로 넘기므로 충분하다.
  return new Blob([new Uint8Array(bytes)]);
}

describe("NotionClient.uploadFile — 크기별 업로드 모드", () => {
  it("20MB 이하 → single_part (mode 미지정 create + part_number 없는 send)", async () => {
    const client = createClient();
    const { create, send, complete } = stubFileUploads(client);

    const id = await client.uploadFile(blobOfSize(1024), "small.png", "image/png");

    expect(id).toBe("upload-1");
    expect(create).toHaveBeenCalledWith({ filename: "small.png", content_type: "image/png" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].part_number).toBeUndefined();
    // single_part 는 send 가 pending 을 돌려줄 때만 complete
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("20MB 초과 → multi_part (number_of_parts + 문자열 part_number + complete)", async () => {
    const client = createClient();
    const { create, send, complete } = stubFileUploads(client);

    // 25MB → 10MB 청크 3개 (10+10+5)
    const size = 25 * 1024 * 1024;
    const id = await client.uploadFile(blobOfSize(size), "big.mp4", "video/mp4");

    expect(id).toBe("upload-1");
    expect(create).toHaveBeenCalledWith({
      mode: "multi_part",
      number_of_parts: 3,
      filename: "big.mp4",
      content_type: "video/mp4",
    });
    expect(send).toHaveBeenCalledTimes(3);
    // API 규격: part_number 는 문자열, 1부터 시작
    expect(send.mock.calls.map((c) => c[0].part_number)).toEqual(["1", "2", "3"]);
    for (const call of send.mock.calls) {
      expect(call[0].file_upload_id).toBe("upload-1");
      expect(call[0].file.filename).toBe("big.mp4");
    }
    // 청크 크기: 10MB, 10MB, 5MB
    const sizes = send.mock.calls.map((c) => (c[0].file.data as Blob).size);
    expect(sizes).toEqual([10 * 1024 * 1024, 10 * 1024 * 1024, 5 * 1024 * 1024]);
    expect(complete).toHaveBeenCalledWith({ file_upload_id: "upload-1" });
  });

  it("경계값 정확히 20MB → single_part 유지", async () => {
    const client = createClient();
    const { create } = stubFileUploads(client);

    await client.uploadFile(blobOfSize(20 * 1024 * 1024), "edge.bin", "application/octet-stream");

    expect(create).toHaveBeenCalledWith({
      filename: "edge.bin",
      content_type: "application/octet-stream",
    });
  });
});
