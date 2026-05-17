import { describe, it, expect } from "vitest";

const {
  evaluatePosture,
  computeMetrics,
  validateBaselineCandidate,
  findKeypoint,
  POSTURE_THRESHOLD,
  BASELINE_DELTA,
  MIN_KEYPOINT_SCORE,
  CONSECUTIVE_BAD_THRESHOLD,
  DEFAULT_CHECK_INTERVAL_SEC,
} = require("../lib/posture-detector.js");

// ===== 테스트 헬퍼 =====

/**
 * 기본 키포인트 세트 — 정상 자세.
 * 어깨 너비 100, 코는 어깨 위쪽, 귀도 어깨 위쪽에 위치.
 *   noseShoulderRatio = (200-80)/100 = 1.2
 *   earShoulderRatio  = (200-85)/100 = 1.15
 */
function createKeypoints(overrides = {}) {
  const defaults = {
    nose: { name: "nose", x: 160, y: 80, score: 0.9 },
    left_ear: { name: "left_ear", x: 145, y: 85, score: 0.9 },
    right_ear: { name: "right_ear", x: 175, y: 85, score: 0.9 },
    left_shoulder: { name: "left_shoulder", x: 110, y: 200, score: 0.9 },
    right_shoulder: { name: "right_shoulder", x: 210, y: 200, score: 0.9 },
  };

  const merged = { ...defaults, ...overrides };

  return [
    merged.nose,
    { name: "left_eye", x: 155, y: 78, score: 0.8 },
    { name: "right_eye", x: 165, y: 78, score: 0.8 },
    merged.left_ear,
    merged.right_ear,
    merged.left_shoulder,
    merged.right_shoulder,
    { name: "left_elbow", x: 100, y: 280, score: 0.5 },
    { name: "right_elbow", x: 220, y: 280, score: 0.5 },
    { name: "left_wrist", x: 95, y: 350, score: 0.4 },
    { name: "right_wrist", x: 225, y: 350, score: 0.4 },
    { name: "left_hip", x: 130, y: 380, score: 0.6 },
    { name: "right_hip", x: 190, y: 380, score: 0.6 },
    { name: "left_knee", x: 125, y: 480, score: 0.5 },
    { name: "right_knee", x: 195, y: 480, score: 0.5 },
    { name: "left_ankle", x: 120, y: 570, score: 0.4 },
    { name: "right_ankle", x: 200, y: 570, score: 0.4 },
  ];
}

// 코+귀를 동시에 어깨 가까이 끌어내려 거북목 두 신호를 모두 충족시키는 헬퍼
function turtleKeypoints() {
  return createKeypoints({
    nose: { name: "nose", x: 160, y: 160, score: 0.9 },          // ratio 0.40 < 0.55
    left_ear: { name: "left_ear", x: 145, y: 185, score: 0.9 },  // ratio 0.15 < 0.20
    right_ear: { name: "right_ear", x: 175, y: 185, score: 0.9 },
  });
}

// ===== findKeypoint =====

describe("findKeypoint", () => {
  it("should return keypoint by name", () => {
    const kps = createKeypoints();
    expect(findKeypoint(kps, "nose")).toMatchObject({ x: 160, y: 80 });
  });

  it("should return undefined for missing keypoint", () => {
    expect(findKeypoint(createKeypoints(), "ghost")).toBeUndefined();
  });

  it("should return undefined for empty array", () => {
    expect(findKeypoint([], "nose")).toBeUndefined();
  });
});

// ===== evaluatePosture - 절대 임계값 모드 (baseline 없음) =====

describe("evaluatePosture (absolute mode)", () => {
  describe("정상 자세", () => {
    it("returns isGood=true for normal posture", () => {
      const result = evaluatePosture(createKeypoints());
      expect(result.isGood).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.mode).toBe("absolute");
    });
  });

  describe("키포인트 신뢰도 부족 → uncertain", () => {
    it("low nose score → mode=uncertain, isGood=true", () => {
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 80, score: 0.1 },
      }));
      expect(result.mode).toBe("uncertain");
      expect(result.isGood).toBe(true);
      expect(result.issues).toContain("키포인트 신뢰도 부족");
    });

    it("low left_shoulder score → uncertain", () => {
      const result = evaluatePosture(createKeypoints({
        left_shoulder: { name: "left_shoulder", x: 110, y: 200, score: 0.1 },
      }));
      expect(result.mode).toBe("uncertain");
    });

    it("low right_shoulder score → uncertain", () => {
      const result = evaluatePosture(createKeypoints({
        right_shoulder: { name: "right_shoulder", x: 210, y: 200, score: 0.1 },
      }));
      expect(result.mode).toBe("uncertain");
    });

    it("missing nose → uncertain", () => {
      const kps = createKeypoints();
      kps[0] = { name: "not_nose", x: 0, y: 0, score: 0.9 };
      expect(evaluatePosture(kps).mode).toBe("uncertain");
    });

    it("score at exact MIN_KEYPOINT_SCORE boundary is accepted", () => {
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 80, score: MIN_KEYPOINT_SCORE },
        left_shoulder: { name: "left_shoulder", x: 110, y: 200, score: MIN_KEYPOINT_SCORE },
        right_shoulder: { name: "right_shoulder", x: 210, y: 200, score: MIN_KEYPOINT_SCORE },
      }));
      expect(result.mode).toBe("absolute");
    });

    it("score just below MIN_KEYPOINT_SCORE → uncertain", () => {
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 80, score: MIN_KEYPOINT_SCORE - 0.01 },
      }));
      expect(result.mode).toBe("uncertain");
    });

    it("shoulder width < 10 → uncertain", () => {
      const result = evaluatePosture(createKeypoints({
        left_shoulder: { name: "left_shoulder", x: 155, y: 200, score: 0.9 },
        right_shoulder: { name: "right_shoulder", x: 160, y: 200, score: 0.9 },
      }));
      expect(result.mode).toBe("uncertain");
    });
  });

  describe("거북목 — 강/약 신호 트리", () => {
    it("two weak signals together → 거북목", () => {
      // 코 ratio 0.40, 귀 ratio 0.15 — 둘 다 약 임계값 아래(severe 는 아님)
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 160, score: 0.9 },          // 0.40 == noseSevere 경계 → strict < 로는 약
        left_ear: { name: "left_ear", x: 145, y: 185, score: 0.9 },  // 0.15
        right_ear: { name: "right_ear", x: 175, y: 185, score: 0.9 },
      }));
      expect(result.issues).toContain("거북목");
      expect(result.issues).not.toContain("구부정한 자세");
    });

    it("severe nose signal alone (< noseShoulderSevere) → 거북목", () => {
      // 코 ratio 0.30 — 강 임계값 아래
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 170, score: 0.9 },
      }));
      expect(result.issues).toContain("거북목");
    });

    it("severe ear signal alone (< earShoulderSevere) → 거북목", () => {
      // 귀 ratio 0.05 — 매우 가까움
      const result = evaluatePosture(createKeypoints({
        left_ear: { name: "left_ear", x: 145, y: 195, score: 0.9 },
        right_ear: { name: "right_ear", x: 175, y: 195, score: 0.9 },
      }));
      expect(result.issues).toContain("거북목");
    });

    it("weak nose alone (between severe and weak) → 구부정", () => {
      // 코 ratio 0.50 — 약 임계 아래, 강 임계 위
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 150, score: 0.9 },
      }));
      expect(result.issues).toContain("구부정한 자세");
      expect(result.issues).not.toContain("거북목");
    });

    it("weak ear alone (between severe and weak) → 구부정", () => {
      // 귀 ratio 0.15
      const result = evaluatePosture(createKeypoints({
        left_ear: { name: "left_ear", x: 145, y: 185, score: 0.9 },
        right_ear: { name: "right_ear", x: 175, y: 185, score: 0.9 },
      }));
      expect(result.issues).toContain("구부정한 자세");
      expect(result.issues).not.toContain("거북목");
    });
  });

  describe("구부정한 자세", () => {
    it("nose between slouch and turtle threshold → 구부정한 자세", () => {
      // ratio = (200-135)/100 = 0.65 → < 0.70 but > 0.55
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 160, y: 135, score: 0.9 },
      }));
      expect(result.issues).toContain("구부정한 자세");
      expect(result.issues).not.toContain("거북목");
    });

    it("normal posture should not be slouch", () => {
      expect(evaluatePosture(createKeypoints()).issues).not.toContain("구부정한 자세");
    });
  });

  describe("어깨 기울어짐", () => {
    it("detects tilt above threshold", () => {
      // |191-200|/100 = 0.09 > 0.08
      const result = evaluatePosture(createKeypoints({
        left_shoulder: { name: "left_shoulder", x: 110, y: 191, score: 0.9 },
      }));
      expect(result.issues).toContain("어깨 기울어짐");
    });

    it("not detected at exact threshold", () => {
      const result = evaluatePosture(createKeypoints({
        left_shoulder: { name: "left_shoulder", x: 110, y: 192, score: 0.9 },
      }));
      expect(result.issues).not.toContain("어깨 기울어짐");
    });
  });

  describe("고개 회전 / 기울어짐 / 한쪽 기울", () => {
    it("detects head rotation by ear confidence gap", () => {
      const result = evaluatePosture(createKeypoints({
        right_ear: { name: "right_ear", x: 175, y: 85, score: 0.3 },
      }));
      expect(result.issues).toContain("고개 회전");
    });

    it("detects head tilt by left-right ear y difference", () => {
      const result = evaluatePosture(createKeypoints({
        left_ear: { name: "left_ear", x: 145, y: 75, score: 0.9 },
        right_ear: { name: "right_ear", x: 175, y: 95, score: 0.9 },
      }));
      expect(result.issues).toContain("고개 기울어짐");
    });

    it("detects body lean when nose is off-center", () => {
      const result = evaluatePosture(createKeypoints({
        nose: { name: "nose", x: 180, y: 80, score: 0.9 },
      }));
      expect(result.issues).toContain("한쪽으로 기울어짐");
    });
  });

  describe("복합 문제 감지", () => {
    it("detects turtle + shoulder tilt simultaneously", () => {
      const kps = turtleKeypoints();
      // 어깨도 기울어진 채로 덮어쓰기
      const result = evaluatePosture([
        ...kps.filter((k) => k.name !== "left_shoulder"),
        { name: "left_shoulder", x: 110, y: 190, score: 0.9 },
      ]);
      expect(result.isGood).toBe(false);
      expect(result.issues).toContain("거북목");
      expect(result.issues).toContain("어깨 기울어짐");
    });
  });
});

// ===== evaluatePosture - baseline 대비 delta 모드 =====

describe("evaluatePosture (baseline mode)", () => {
  // 정상 자세를 baseline 으로 채택
  const baselineMetrics = computeMetrics(createKeypoints());
  const baseline = { capturedAt: "2026-01-01T00:00:00Z", metrics: baselineMetrics };

  it("returns mode=baseline when baseline is provided", () => {
    const result = evaluatePosture(createKeypoints(), baseline);
    expect(result.mode).toBe("baseline");
  });

  it("treats same-as-baseline pose as good", () => {
    const result = evaluatePosture(createKeypoints(), baseline);
    expect(result.isGood).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects turtle neck when nose+ear weak drops fire together", () => {
    // baseline noseRatio=1.2 / earRatio=1.15. 둘 다 약 임계(0.10/0.06) 초과 drop
    const now = createKeypoints({
      nose: { name: "nose", x: 160, y: 95, score: 0.9 },          // ratio=1.05 drop=0.15
      left_ear: { name: "left_ear", x: 145, y: 100, score: 0.9 }, // ratio=1.00 drop=0.15
      right_ear: { name: "right_ear", x: 175, y: 100, score: 0.9 },
    });
    const result = evaluatePosture(now, baseline);
    expect(result.issues).toContain("거북목");
  });

  it("detects turtle from severe single drop (nose only)", () => {
    // baseline noseRatio=1.2. now=0.90 → drop=0.30 > 강 임계 0.20
    const now = createKeypoints({
      nose: { name: "nose", x: 160, y: 110, score: 0.9 },
    });
    const result = evaluatePosture(now, baseline);
    expect(result.issues).toContain("거북목");
  });

  it("weak single drop → 구부정 (not 거북목)", () => {
    // 코만 약 drop (0.10 ~ 0.20 사이)
    const now = createKeypoints({
      nose: { name: "nose", x: 160, y: 92, score: 0.9 },  // ratio=1.08 drop=0.12
    });
    const result = evaluatePosture(now, baseline);
    expect(result.issues).toContain("구부정한 자세");
    expect(result.issues).not.toContain("거북목");
  });

  it("detects shoulder tilt increase against baseline", () => {
    // baseline shoulderTilt=0, now=0.05 → delta 0.05 > 0.04
    const now = createKeypoints({
      left_shoulder: { name: "left_shoulder", x: 110, y: 195, score: 0.9 },
    });
    const result = evaluatePosture(now, baseline);
    expect(result.issues).toContain("어깨 기울어짐");
  });

  it("absolute-mode tilt threshold (0.08) would NOT fire here", () => {
    // 같은 값으로 절대 모드 평가 시: 0.05 < 0.08 → 안 잡힘
    const now = createKeypoints({
      left_shoulder: { name: "left_shoulder", x: 110, y: 195, score: 0.9 },
    });
    const result = evaluatePosture(now);
    expect(result.issues).not.toContain("어깨 기울어짐");
  });

  it("uncertain (low keypoint score) still returns uncertain regardless of baseline", () => {
    const result = evaluatePosture(createKeypoints({
      nose: { name: "nose", x: 160, y: 80, score: 0.1 },
    }), baseline);
    expect(result.mode).toBe("uncertain");
  });
});

// ===== computeMetrics =====

describe("computeMetrics", () => {
  it("returns null when nose is missing", () => {
    const kps = createKeypoints();
    kps[0] = { name: "not_nose", x: 0, y: 0, score: 0.9 };
    expect(computeMetrics(kps)).toBeNull();
  });

  it("returns null when shoulder width < 10", () => {
    expect(computeMetrics(createKeypoints({
      left_shoulder: { name: "left_shoulder", x: 155, y: 200, score: 0.9 },
      right_shoulder: { name: "right_shoulder", x: 160, y: 200, score: 0.9 },
    }))).toBeNull();
  });

  it("computes normalized ratios for normal posture", () => {
    const m = computeMetrics(createKeypoints());
    expect(m.noseShoulderRatio).toBeCloseTo(1.2);
    expect(m.earShoulderRatio).toBeCloseTo(1.15);
    expect(m.shoulderTilt).toBe(0);
    expect(m.shoulderWidth).toBe(100);
  });

  it("earShoulderRatio is null when both ears unreliable", () => {
    const m = computeMetrics(createKeypoints({
      left_ear: { name: "left_ear", x: 145, y: 85, score: 0.1 },
      right_ear: { name: "right_ear", x: 175, y: 85, score: 0.1 },
    }));
    expect(m.earShoulderRatio).toBeNull();
    expect(m.headTilt).toBeNull();
  });

  it("falls back to right ear when left ear is unreliable", () => {
    const m = computeMetrics(createKeypoints({
      left_ear: { name: "left_ear", x: 145, y: 85, score: 0.1 },
      right_ear: { name: "right_ear", x: 175, y: 85, score: 0.9 },
    }));
    expect(m.earShoulderRatio).toBeCloseTo(1.15);
  });
});

// ===== validateBaselineCandidate =====

describe("validateBaselineCandidate", () => {
  it("accepts a good posture as baseline", () => {
    const m = computeMetrics(createKeypoints());
    expect(validateBaselineCandidate(m)).toEqual({ ok: true });
  });

  it("rejects null metrics", () => {
    const v = validateBaselineCandidate(null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("키포인트");
  });

  it("rejects already-slouching pose", () => {
    // ratio = 0.65 < 0.70 (slouch threshold)
    const m = computeMetrics(createKeypoints({
      nose: { name: "nose", x: 160, y: 135, score: 0.9 },
    }));
    const v = validateBaselineCandidate(m);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("자세가 이미");
  });

  it("rejects tilted shoulders", () => {
    const m = computeMetrics(createKeypoints({
      left_shoulder: { name: "left_shoulder", x: 110, y: 191, score: 0.9 },
    }));
    const v = validateBaselineCandidate(m);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("어깨");
  });
});

// ===== 상수 =====

describe("constants", () => {
  it("POSTURE_THRESHOLD has expected absolute values", () => {
    expect(POSTURE_THRESHOLD.noseShoulderRatio).toBe(0.55);
    expect(POSTURE_THRESHOLD.earShoulderRatio).toBe(0.20);
    expect(POSTURE_THRESHOLD.shoulderTiltRatio).toBe(0.08);
    expect(POSTURE_THRESHOLD.headRotationConfidenceDiff).toBe(0.45);
    expect(POSTURE_THRESHOLD.headTiltRatio).toBe(0.08);
    expect(POSTURE_THRESHOLD.noseCenterOffset).toBe(0.12);
    expect(POSTURE_THRESHOLD.slouchRatio).toBe(0.70);
  });

  it("BASELINE_DELTA has expected delta values", () => {
    expect(BASELINE_DELTA.noseShoulderDrop).toBe(0.10);
    expect(BASELINE_DELTA.earShoulderDrop).toBe(0.06);
    expect(BASELINE_DELTA.shoulderTiltIncrease).toBe(0.04);
  });

  it("MIN_KEYPOINT_SCORE is 0.3", () => {
    expect(MIN_KEYPOINT_SCORE).toBe(0.3);
  });

  it("CONSECUTIVE_BAD_THRESHOLD is 2", () => {
    expect(CONSECUTIVE_BAD_THRESHOLD).toBe(2);
  });

  it("DEFAULT_CHECK_INTERVAL_SEC is 40", () => {
    expect(DEFAULT_CHECK_INTERVAL_SEC).toBe(40);
  });
});
