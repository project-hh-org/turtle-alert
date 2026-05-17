/**
 * TensorFlow.js / 카메라 의존 함수
 * 외부 하드웨어·라이브러리에 의존하므로 단위 테스트 불가 → 커버리지 제외 대상
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { getImagesnapPath } = require("./imagesnap-path");

const CAPTURE_WIDTH = 320;
const CAPTURE_HEIGHT = 240;

let detector = null;
let tf = null;

async function initDetector() {
  if (detector) return true;

  try {
    tf = require("@tensorflow/tfjs");
    // Electron 메인 프로세스는 Node 환경 — WebGL/WebGPU 백엔드가 없으므로
    // CPU 백엔드를 명시적으로 초기화해야 한다.
    require("@tensorflow/tfjs-backend-cpu");
    await tf.setBackend("cpu");
    await tf.ready();

    // `@tensorflow-models/pose-detection` 의 index.js 를 쓰면 사용하지 않는 BlazePose /
    // PoseNet 디텍터까지 정적 require 되면서 @mediapipe/pose, tfjs-backend-webgpu 같은
    // 숨은 peer 의존성을 줄줄이 끌어온다. MoveNet 만 쓰는 우리 앱에서는 detector
    // 파일을 직접 import 해서 불필요한 로드를 피한다.
    const movenet = require("@tensorflow-models/pose-detection/dist/movenet/detector");
    const { SINGLEPOSE_LIGHTNING } = require("@tensorflow-models/pose-detection/dist/movenet/constants");

    detector = await movenet.load({ modelType: SINGLEPOSE_LIGHTNING });
    return true;
  } catch (err) {
    console.error("posture-detector: 모델 로드 실패", err.message);
    detector = null;
    return false;
  }
}

async function captureFrame() {
  const tmpFile = path.join(
    os.tmpdir(),
    `turtle-posture-${Date.now()}.jpg`
  );

  await new Promise((resolve, reject) => {
    execFile(
      getImagesnapPath(),
      ["-q", "-w", "0.5", tmpFile],
      { timeout: 10000 },
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });

  try {
    const imageBuffer = fs.readFileSync(tmpFile);
    const jpeg = require("jpeg-js");
    const { data, width, height } = jpeg.decode(imageBuffer, { useTArray: true });
    const rgbData = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgbData[j] = data[i];
      rgbData[j + 1] = data[i + 1];
      rgbData[j + 2] = data[i + 2];
    }
    const decoded = tf.tensor3d(rgbData, [height, width, 3]);
    const resized = tf.image.resizeBilinear(decoded, [
      CAPTURE_HEIGHT,
      CAPTURE_WIDTH,
    ]);
    decoded.dispose();
    return resized;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 무시
    }
  }
}

async function captureAndAnalyze(baseline) {
  if (!detector) {
    throw new Error("detector가 초기화되지 않았습니다");
  }

  const { evaluatePosture } = require("./posture-detector");
  const frame = await captureFrame();
  try {
    const poses = await detector.estimatePoses(frame);
    if (!poses || poses.length === 0) {
      return { isGood: true, issues: ["포즈를 감지하지 못했습니다"], mode: "uncertain" };
    }
    return evaluatePosture(poses[0].keypoints, baseline);
  } finally {
    frame.dispose();
  }
}

/**
 * 사용자가 "지금이 바른 자세" 선언 시 호출.
 * 1회 캡처 → metrics 계산 → 유효성 검증 후 baseline 객체 반환.
 *
 * @returns {Promise<{ok: true, baseline: object} | {ok: false, reason: string}>}
 */
async function captureBaseline() {
  if (!detector) {
    throw new Error("detector가 초기화되지 않았습니다");
  }
  const { computeMetrics, validateBaselineCandidate } = require("./posture-detector");
  const frame = await captureFrame();
  try {
    const poses = await detector.estimatePoses(frame);
    if (!poses || poses.length === 0) {
      return { ok: false, reason: "포즈를 감지하지 못했습니다 — 카메라 앞에 정면으로 앉아주세요" };
    }
    const metrics = computeMetrics(poses[0].keypoints);
    const check = validateBaselineCandidate(metrics);
    if (!check.ok) return { ok: false, reason: check.reason };
    return {
      ok: true,
      baseline: {
        capturedAt: new Date().toISOString(),
        metrics,
      },
    };
  } finally {
    frame.dispose();
  }
}

async function disposeDetector() {
  if (detector) {
    detector.dispose();
    detector = null;
  }
}

module.exports = {
  initDetector,
  captureAndAnalyze,
  captureBaseline,
  disposeDetector,
};
