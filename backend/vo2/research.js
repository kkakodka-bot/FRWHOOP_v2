/** Citation table for vo2_v1. Coefficients in methodology.js should trace here. */

export const RESEARCH_TABLE = [
  {
    metric: 'uth_baseline',
    paper: 'Uth N et al. Estimation of VO2max from the ratio between HRmax and HRrest. Eur J Appl Physiol. 2004',
    doi: '10.1007/s00421-003-0988-y',
    usedAs: 'VO2max ≈ 15.3 × HRmax / HRrest; baseline and sanity check only',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'tanaka_hrmax',
    paper: 'Tanaka H, Monahan KD, Seals DR. Age-predicted maximal heart rate revisited. JACC. 2001',
    doi: '10.1016/S0735-1097(00)01054-8',
    usedAs: 'HRmax = 208 − 0.7 × age when tested/observed HRmax is unavailable',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'jackson_nonexercise',
    paper: 'Jackson AS et al. Prediction of functional aerobic capacity without exercise testing. Med Sci Sports Exerc. 1990',
    doi: '10.1249/00005768-199012000-00021',
    usedAs: 'Non-exercise VO2max from age, sex, BMI, physical-activity rating',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'friend_registry',
    paper: 'Kaminsky LA et al. The FRIEND registry. Prog Cardiovasc Dis. 2017 / Mayo Clin Proc. 2015',
    doi: '10.1016/j.pcad.2017.03.004',
    usedAs: 'Fitness-distribution context; Jackson-style equation remains the explicit production formula',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'acsm_running_cost',
    paper: 'ACSM Guidelines for Exercise Testing and Prescription (walking/running metabolic equations)',
    doi: null,
    usedAs: 'VO2 cost from speed and grade on stable GPS segments',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'swain_hrr_vo2r',
    paper: 'Swain DP, Leutholtz BC. Heart rate reserve is equivalent to %VO2 reserve. Med Sci Sports Exerc. 1997',
    doi: '10.1097/00005768-199703000-00024',
    usedAs: '%VO2R ≈ %HRR for submaximal GPS extrapolation',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'whoop_vo2_product',
    paper: 'WHOOP VO2 Max support / engineering notes (public)',
    doi: null,
    usedAs: 'Eligibility gates, weekly cadence, GPS vs passive tiers, published MAE 3.7 / 3.3 as aspirational benchmarks',
    tag: 'KNOWN WHOOP BEHAVIOR',
  },
  {
    metric: 'firstbeat_structure',
    paper: 'Firstbeat white paper on VO2max estimation from HR and running speed (public methodology)',
    doi: null,
    usedAs: 'Segment reliability + HR vs workload structure; no proprietary constants copied',
    tag: 'PUBLISHED SCIENCE',
  },
  {
    metric: 'geniemax_reference',
    paper: 'GenieMax Core (MIT) inspected as an implementation reference for Uth/Tanaka',
    doi: null,
    usedAs: 'Independent reimplementation from papers; Swift is not vendored',
    tag: 'OPEN SOURCE IMPLEMENTATION',
  },
  {
    metric: 'physionet_malaga',
    paper: 'Mongin D et al. Cardio-respiratory data from a cycle-ergometer exercise test. PhysioNet. 2021',
    doi: '10.13026/s6xf-0z57',
    usedAs: 'Optional offline evaluation only; dataset is not vendored; split by participant',
    tag: 'PUBLISHED SCIENCE',
  },
];
