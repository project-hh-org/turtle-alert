// 자세 판정 — 표준 절대 임계값 + (옵션) 사용자 캘리브레이션 baseline 대비 delta
//
// 두 모드:
//   1. baseline 없음 → 절대 임계값(POSTURE_THRESHOLD)으로 평가. 첫 사용/캘리브레이션
//      안 한 사용자에게도 동작.
//   2. baseline 있음 → 사용자의 "바른 자세" 스냅샷 대비 delta 임계값(BASELINE_DELTA)
//      으로 평가. 카메라 위치/체형/촬영 각도 영향이 거의 사라져 훨씬 정확.
//
// 거북목 판정은 단일 신호가 아닌 다중 신호로 — 코-어깨 비율 / 귀-어깨 수직 비율 /
// (baseline 모드) 귀-어깨 x 오프셋 변화 중 2개 이상이 임계 초과면 라벨링.

// 절대 임계값 (baseline 없을 때 사용)
//
// 판정 트리:
//   1. 강한 단일 신호 (noseSevere 또는 earSevere) → 거북목
//   2. 두 약한 신호 동시 (nose < noseShoulderRatio AND ear < earShoulderRatio) → 거북목
//   3. 그 외 약한 신호 (nose < slouchRatio 단독 또는 ear < earShoulderRatio 단독) → 구부정
//
// 이전 버전에서 거북목인 사용자가 라벨링되지 않았던 사례를 반영해 단일 강한 신호도
// 거북목으로 인정하도록 조정했다.
const POSTURE_THRESHOLD = {
  // 거북목 신호 1 (약): 코가 어깨 높이에 가까움
  noseShoulderRatio: 0.55,
  // 거북목 신호 1 (강): 코가 어깨에 매우 가까움 — 단독으로도 거북목
  noseShoulderSevere: 0.40,
  // 거북목 신호 2 (약): 귀가 어깨 높이에 가까움 (정면 카메라에서 거북목일수록 작아짐)
  earShoulderRatio: 0.20,
  // 거북목 신호 2 (강): 귀가 어깨에 매우 가까움 — 단독으로도 거북목
  earShoulderSevere: 0.10,
  // 어깨 기울기
  shoulderTiltRatio: 0.08,
  // 좌우 귀 신뢰도 차이 → 고개 회전
  headRotationConfidenceDiff: 0.45,
  // 좌우 귀 y 차이 비율 → 고개 기울어짐
  headTiltRatio: 0.08,
  // 코 중심 이탈 비율 → 한쪽으로 기울어짐
  noseCenterOffset: 0.12,
  // 구부정 판정 (거북목보다 가벼운 단계)
  slouchRatio: 0.70,
};

// baseline 대비 delta 임계값 (calibration 모드에서 사용)
// 절대값보다 훨씬 작게 잡을 수 있음 — "내 평소보다 얼마나 나빠졌나"
//
// 절대 모드와 동일한 단/이중 신호 트리 적용:
//   1. 큰 단독 drop (noseSevere 또는 earSevere) → 거북목
//   2. 두 약한 drop 동시 → 거북목
//   3. 그 외 단독 drop → 구부정
const BASELINE_DELTA = {
  // 거북목 신호 1 (약): 코-어깨 비율이 baseline 대비 이만큼 줄어듦
  noseShoulderDrop: 0.10,
  // 거북목 신호 1 (강): 코-어깨 비율 단독 큰 drop
  noseShoulderSevere: 0.20,
  // 거북목 신호 2 (약): 귀-어깨 비율이 baseline 대비 이만큼 줄어듦
  earShoulderDrop: 0.06,
  // 거북목 신호 2 (강): 귀-어깨 비율 단독 큰 drop
  earShoulderSevere: 0.15,
  // 거북목 신호 3: 귀-어깨 수평거리 변화 (보조)
  earForwardX: 0.06,
  // 어깨 기울기 증가량
  shoulderTiltIncrease: 0.04,
  // 한쪽으로 기울어짐 증가량
  noseOffsetIncrease: 0.05,
  // 고개 기울어짐 증가량
  headTiltIncrease: 0.04,
  // 구부정 (약한 단독 신호)
  noseShoulderSlouch: 0.06,
};

// 최소 키포인트 신뢰도
const MIN_KEYPOINT_SCORE = 0.3;

// 체크 간격 (초)
const DEFAULT_CHECK_INTERVAL_SEC = 40;

// 연속 나쁜 자세 감지 횟수
const CONSECUTIVE_BAD_THRESHOLD = 2;

/**
 * 키포인트 배열에서 이름으로 찾습니다.
 */
function findKeypoint(keypoints, name) {
  return keypoints.find((kp) => kp.name === name);
}

/**
 * 키포인트로부터 자세 비교에 쓰이는 정규화된 지표를 계산합니다.
 * 어깨 너비(픽셀)로 나눠 카메라 거리에 거의 무관한 비율을 만드는 게 핵심.
 *
 * 반환값이 null 이면 신뢰 가능한 측정 불가 (어깨/코 신뢰도 부족 등).
 *
 * @returns {null | {
 *   noseShoulderRatio: number,
 *   earShoulderRatio: number | null,
 *   earForwardX: number | null,
 *   shoulderTilt: number,
 *   noseOffset: number,
 *   headTilt: number | null,
 *   headRotationDiff: number | null,
 *   shoulderWidth: number,
 *   confidence: { nose, leftShoulder, rightShoulder, leftEar, rightEar }
 * }}
 */
function computeMetrics(keypoints) {
  const nose = findKeypoint(keypoints, "nose");
  const leftShoulder = findKeypoint(keypoints, "left_shoulder");
  const rightShoulder = findKeypoint(keypoints, "right_shoulder");
  const leftEar = findKeypoint(keypoints, "left_ear");
  const rightEar = findKeypoint(keypoints, "right_ear");

  if (
    !nose || nose.score < MIN_KEYPOINT_SCORE ||
    !leftShoulder || leftShoulder.score < MIN_KEYPOINT_SCORE ||
    !rightShoulder || rightShoulder.score < MIN_KEYPOINT_SCORE
  ) {
    return null;
  }

  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
  if (shoulderWidth < 10) return null;

  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;

  const noseShoulderRatio = (shoulderMidY - nose.y) / shoulderWidth;
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y) / shoulderWidth;
  const noseOffset = Math.abs(nose.x - shoulderMidX) / shoulderWidth;

  const usableEar = (leftEar && leftEar.score >= MIN_KEYPOINT_SCORE) ? leftEar
    : (rightEar && rightEar.score >= MIN_KEYPOINT_SCORE) ? rightEar
      : null;

  const earShoulderRatio = usableEar
    ? (shoulderMidY - usableEar.y) / shoulderWidth
    : null;

  // 귀가 정면 카메라에서 어깨 중심 X로부터 얼마나 떨어졌는가.
  // 거북목이 심해지면 얼굴이 정면을 향해 기울며 귀가 어깨 중심선 안쪽으로 들어옴.
  const earForwardX = usableEar
    ? Math.abs(usableEar.x - shoulderMidX) / shoulderWidth
    : null;

  let headTilt = null;
  if (
    leftEar && leftEar.score >= MIN_KEYPOINT_SCORE &&
    rightEar && rightEar.score >= MIN_KEYPOINT_SCORE
  ) {
    headTilt = Math.abs(leftEar.y - rightEar.y) / shoulderWidth;
  }

  const headRotationDiff = (leftEar && rightEar)
    ? Math.abs(leftEar.score - rightEar.score)
    : null;

  return {
    noseShoulderRatio,
    earShoulderRatio,
    earForwardX,
    shoulderTilt,
    noseOffset,
    headTilt,
    headRotationDiff,
    shoulderWidth,
    confidence: {
      nose: nose.score,
      leftShoulder: leftShoulder.score,
      rightShoulder: rightShoulder.score,
      leftEar: leftEar ? leftEar.score : 0,
      rightEar: rightEar ? rightEar.score : 0,
    },
  };
}

/**
 * baseline 후보로 충분히 좋은 지표인지 검증.
 * 신뢰도가 낮거나 이미 안 좋은 자세를 baseline 으로 저장하지 않도록 가드.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function validateBaselineCandidate(metrics) {
  if (!metrics) return { ok: false, reason: "키포인트 신뢰도 부족" };
  // 캘리브레이션 시점에 이미 거북목/구부정 영역이면 baseline 으로 부적합
  if (metrics.noseShoulderRatio < POSTURE_THRESHOLD.slouchRatio) {
    return { ok: false, reason: "현재 자세가 이미 좋지 않습니다 — 바른 자세로 다시 시도해주세요" };
  }
  if (
    metrics.earShoulderRatio !== null &&
    metrics.earShoulderRatio < POSTURE_THRESHOLD.earShoulderRatio
  ) {
    return { ok: false, reason: "고개가 이미 숙여진 상태로 보입니다 — 바른 자세로 다시 시도해주세요" };
  }
  if (metrics.shoulderTilt > POSTURE_THRESHOLD.shoulderTiltRatio) {
    return { ok: false, reason: "어깨가 기울어져 있습니다 — 바른 자세로 다시 시도해주세요" };
  }
  return { ok: true };
}

/**
 * 키포인트 기반 자세 판정.
 * baseline 인자가 주어지면 delta 기반 판정, 없으면 절대 임계값.
 *
 * @param {Array<{name: string, x: number, y: number, score: number}>} keypoints
 * @param {object} [baseline] — captureBaseline 으로 만든 객체. {metrics: {...}}
 * @returns {{isGood: boolean, issues: string[], metrics?: object, mode: 'baseline' | 'absolute' | 'uncertain'}}
 */
function evaluatePosture(keypoints, baseline) {
  const metrics = computeMetrics(keypoints);

  if (!metrics) {
    // 키포인트 신뢰도 부족 — 알림은 띄우지 않지만(uncertain) 명시적으로 보고
    return {
      isGood: true,
      issues: ["키포인트 신뢰도 부족"],
      mode: "uncertain",
    };
  }

  const useBaseline = baseline && baseline.metrics;
  const issues = useBaseline
    ? evaluateAgainstBaseline(metrics, baseline.metrics)
    : evaluateAbsolute(metrics);

  return {
    isGood: issues.length === 0,
    issues,
    metrics,
    mode: useBaseline ? "baseline" : "absolute",
  };
}

/**
 * 절대 임계값으로 평가 (baseline 없을 때).
 *
 * 거북목 판정:
 *   - 강 단독: 코 < noseShoulderSevere 또는 귀 < earShoulderSevere → 거북목
 *   - 약 이중: 코 < noseShoulderRatio AND 귀 < earShoulderRatio → 거북목
 *   - 약 단독: 코 < slouchRatio 또는 귀 < earShoulderRatio → 구부정한 자세
 */
function evaluateAbsolute(m) {
  const issues = [];

  const noseWeak = m.noseShoulderRatio < POSTURE_THRESHOLD.noseShoulderRatio;
  const noseSevere = m.noseShoulderRatio < POSTURE_THRESHOLD.noseShoulderSevere;
  const earReliable = m.earShoulderRatio !== null;
  const earWeak = earReliable && m.earShoulderRatio < POSTURE_THRESHOLD.earShoulderRatio;
  const earSevere = earReliable && m.earShoulderRatio < POSTURE_THRESHOLD.earShoulderSevere;

  const isTurtle = noseSevere || earSevere || (noseWeak && earWeak);

  if (isTurtle) {
    issues.push("거북목");
  } else if (
    noseWeak ||
    earWeak ||
    m.noseShoulderRatio < POSTURE_THRESHOLD.slouchRatio
  ) {
    issues.push("구부정한 자세");
  }

  if (m.shoulderTilt > POSTURE_THRESHOLD.shoulderTiltRatio) {
    issues.push("어깨 기울어짐");
  }
  if (m.headRotationDiff !== null && m.headRotationDiff > POSTURE_THRESHOLD.headRotationConfidenceDiff) {
    issues.push("고개 회전");
  }
  if (m.headTilt !== null && m.headTilt > POSTURE_THRESHOLD.headTiltRatio) {
    issues.push("고개 기울어짐");
  }
  if (m.noseOffset > POSTURE_THRESHOLD.noseCenterOffset) {
    issues.push("한쪽으로 기울어짐");
  }

  return issues;
}

/**
 * baseline 대비 delta 로 평가 (캘리브레이션 모드).
 *
 * 절대 모드와 같은 강/약 신호 트리:
 *   - 강 단독 drop: 코 drop > noseShoulderSevere 또는 귀 drop > earShoulderSevere → 거북목
 *   - 약 이중 drop: 코 drop > noseShoulderDrop AND 귀 drop > earShoulderDrop → 거북목
 *   - 약 단독 drop: → 구부정한 자세
 */
function evaluateAgainstBaseline(now, base) {
  const issues = [];

  const noseDrop = base.noseShoulderRatio - now.noseShoulderRatio;
  const earReliable = now.earShoulderRatio !== null && base.earShoulderRatio !== null;
  const earDrop = earReliable ? base.earShoulderRatio - now.earShoulderRatio : 0;

  const noseWeak = noseDrop > BASELINE_DELTA.noseShoulderDrop;
  const noseSevere = noseDrop > BASELINE_DELTA.noseShoulderSevere;
  const earWeak = earReliable && earDrop > BASELINE_DELTA.earShoulderDrop;
  const earSevere = earReliable && earDrop > BASELINE_DELTA.earShoulderSevere;

  // 보조 신호: 귀가 어깨 중심으로 더 들어옴 (얼굴이 정면 기울어짐)
  let earForwardSignal = false;
  if (now.earForwardX !== null && base.earForwardX !== null) {
    earForwardSignal = base.earForwardX - now.earForwardX > BASELINE_DELTA.earForwardX;
  }

  const isTurtle = noseSevere || earSevere || (noseWeak && earWeak);

  if (isTurtle) {
    issues.push("거북목");
  } else if (
    noseWeak ||
    earWeak ||
    earForwardSignal ||
    noseDrop > BASELINE_DELTA.noseShoulderSlouch
  ) {
    issues.push("구부정한 자세");
  }

  if (now.shoulderTilt - base.shoulderTilt > BASELINE_DELTA.shoulderTiltIncrease) {
    issues.push("어깨 기울어짐");
  }
  if (
    now.headTilt !== null && base.headTilt !== null &&
    now.headTilt - base.headTilt > BASELINE_DELTA.headTiltIncrease
  ) {
    issues.push("고개 기울어짐");
  }
  if (now.noseOffset - base.noseOffset > BASELINE_DELTA.noseOffsetIncrease) {
    issues.push("한쪽으로 기울어짐");
  }

  return issues;
}

module.exports = {
  evaluatePosture,
  computeMetrics,
  validateBaselineCandidate,
  findKeypoint,
  evaluateAbsolute,
  evaluateAgainstBaseline,
  POSTURE_THRESHOLD,
  BASELINE_DELTA,
  MIN_KEYPOINT_SCORE,
  DEFAULT_CHECK_INTERVAL_SEC,
  CONSECUTIVE_BAD_THRESHOLD,
};
