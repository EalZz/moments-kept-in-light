// ---------- 사이트 설정: 여기만 고치면 이름/문구가 전부 바뀝니다 ----------
window.SITE = {
  name: 'KANEZ',                                   // 워드마크 (placeholder — 나중에 변경)
  kicker: '',                                      // 히어로 위 작은 라벨 — 비우면 숨김
  headline: 'Moments kept\nin light.',             // 히어로 헤드라인 (\n = 줄바꿈)
  intro: 'The moments we met, frame by frame.', // 한 줄 소개
  twitter: 'pht_KANEZ',                            // X(트위터) 핸들 — 비우면 버튼 숨김
  email: 'clapa0211@gmail.com',                    // 연락 이메일 — 비우면 Contact에서 숨김

  // ---------- About 페이지 (자유롭게 수정하세요) ----------
  about: {
    // 소개 문단 (배열 항목 하나 = 한 문단) — 실제 내용은 Admin "About 편집"에서 관리 (이건 폴백)
    intro: [
      '행사와 출사에서 코스프레 사진을 찍는 KANEZ입니다.',
      '캐릭터로 살아 있는 순간의 표정과 빛을 좋아합니다. 우리가 만난 순간이 한 장의 사진으로 오래 남기를 바라며 찍고 있습니다.',
    ],
    // 장비 목록 — 비우면([]) 섹션 숨김
    gear: [
      'Camera · Sony A7 III',
      'Lens · 35mm F1.8 · 85mm F1.8 · 70-180mm F2.8',
    ],
    // 촬영 문의 안내 한 줄 — 비우면 숨김
    note: '촬영 문의나 작업 제안은 X DM 또는 이메일로 편하게 연락 주세요.',
  },
}
