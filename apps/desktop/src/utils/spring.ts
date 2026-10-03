/**
 * 弹簧物理求解器（解析解）。
 *
 * 移植自 AMLL（packages/core/src/utils/spring.ts，MIT，原作者 github.com/pushkine）
 * 与它的速度求导工具。用于歌词行位移：AMLL 的观感之所以比固定贝塞尔「跟手」，
 * 关键在于位移是**物理积分**——目标位置突变时速度是连续的，而 CSS transition 每次
 * 改目标都会从头以零速度起跑，级联切行时会显得一顿一顿。
 *
 * 单位为秒与「像素」（任意位移量纲皆可）。`update(dt)` 由调用方每帧驱动。
 */

/** 弹簧参数：默认 mass=1 / damping=10 / stiffness=100 */
export interface SpringParams {
  mass: number;
  damping: number;
  stiffness: number;
  /**
   * 强制走「过阻尼解析解」分支。
   *
   * 一般不需要——阻尼比足够大时代码本来就会选它；显式打开是为了让调用方
   * 也能拿到那条更平缓的曲线（AMLL 的参数策略里没用到，这里保底兼容）。
   */
  soft: boolean;
}

/** 对一元函数做中心差分求导（用于从位置求速度、从速度求加速度） */
function derivative(fn: (t: number) => number): (t: number) => number {
  const h = 1e-4;
  return (t: number) => (fn(t + h) - fn(t - h)) / (2 * h);
}

/**
 * 求弹簧的解析解 `position(t)`。
 *
 * 阻尼比 `damping / (2 * sqrt(stiffness * mass)) >= 1` 时为过阻尼（无振荡），
 * 否则为欠阻尼（带轻微回弹）。两支都是闭式解，不需要逐步数值积分，
 * 因此不会有累加误差，也不怕帧率抖动。
 */
function solveSpring(
  from: number,
  velocity: number,
  to: number,
  params?: Partial<SpringParams>,
): (t: number) => number {
  const soft = params?.soft ?? false;
  const stiffness = params?.stiffness ?? 100;
  const damping = params?.damping ?? 10;
  const mass = params?.mass ?? 1;
  const delta = to - from;

  if (soft || damping / (2 * Math.sqrt(stiffness * mass)) >= 1) {
    const angularFrequency = -Math.sqrt(stiffness / mass);
    const leftover = -angularFrequency * delta - velocity;
    return (t: number) => {
      if (t < 0) return from;
      return to - (delta + t * leftover) * Math.E ** (t * angularFrequency);
    };
  }

  const dampingFrequency = Math.sqrt(4 * mass * stiffness - damping ** 2);
  const leftover = (damping * delta - 2 * mass * velocity) / dampingFrequency;
  const dfm = (0.5 * dampingFrequency) / mass;
  const dm = -(0.5 * damping) / mass;
  return (t: number) => {
    if (t < 0) return from;
    return to - (Math.cos(t * dfm) * delta + Math.sin(t * dfm) * leftover) * Math.E ** (t * dm);
  };
}

/** 一个弹簧标量：设定目标后逐帧 `update(dt)` 推进 */
export class Spring {
  private currentPosition = 0;
  private targetPosition = 0;
  private currentTime = 0;
  private params: Partial<SpringParams> = {};
  private currentSolver: (t: number) => number;
  private getVelocity: (t: number) => number;

  constructor(currentPosition = 0) {
    this.targetPosition = currentPosition;
    this.currentPosition = currentPosition;
    this.currentSolver = () => this.targetPosition;
    this.getVelocity = () => 0;
  }

  /** 位置与速度都已收敛（调用方可据此停止重排） */
  arrived(): boolean {
    return (
      Math.abs(this.targetPosition - this.currentPosition) < 0.01 &&
      Math.abs(this.getVelocity(this.currentTime)) < 0.01
    );
  }

  /** 立刻落位，不带任何动画（换歌 / 初始化） */
  setPosition(position: number): void {
    this.targetPosition = position;
    this.currentPosition = position;
    this.currentSolver = () => position;
    this.getVelocity = () => 0;
    this.currentTime = 0;
  }

  /** 推进 dt 秒 */
  update(dt: number): void {
    if (dt <= 0) return;
    this.currentTime += dt;
    this.currentPosition = this.currentSolver(this.currentTime);
    if (this.arrived()) this.setPosition(this.targetPosition);
  }

  /** 更新物理参数（下一帧生效） */
  updateParams(params: Partial<SpringParams>): void {
    this.params = { ...this.params, ...params };
    this.resetSolver();
  }

  /** 设定目标位置；与当前位置足够接近时直接落位，避免无意义的重算 */
  setTargetPosition(position: number): void {
    if (Math.abs(this.targetPosition - position) < 0.001) return;
    this.targetPosition = position;
    this.resetSolver();
  }

  getCurrentPosition(): number {
    return this.currentPosition;
  }

  private resetSolver(): void {
    const velocity = this.getVelocity(this.currentTime);
    this.currentTime = 0;
    this.currentSolver = solveSpring(
      this.currentPosition,
      velocity,
      this.targetPosition,
      this.params,
    );
    this.getVelocity = derivative(this.currentSolver);
  }
}

/** 歌词行纵向滚动的弹簧参数策略（对齐 AMLL packages/core/src/lyric-player/base/spring.ts） */
const SLOW_STIFFNESS = 90;
const SLOW_DAMPING = 15;
const MEDIUM_STIFFNESS = 140;
const MEDIUM_DAMPING = 22;
const MIN_INTERVAL = 100;
const MAX_INTERVAL = 800;
const MIN_STIFFNESS = 170;
const MAX_STIFFNESS = 220;
const DAMPING_MULTIPLIER = 2.2;
const INTERVAL_EXPONENT = 0.2;

/**
 * 取行位移的弹簧参数。
 *
 * 与 AMLL 一致：跳转与间奏用慢速档（给用户看清落点的时间），曲末用中速档，
 * 正常播放按**相邻行的时间间隔**映射——间隔越短刚度越高（切得越急），
 * 阻尼固定为 `sqrt(stiffness) * 2.2` 以保证不振荡。
 *
 * @param isSeeking 本帧是否为跳转
 * @param isInterlude 本行是否是间奏三点
 * @param intervalMs 本行与上一行的时间差；首尾行给 undefined
 * @param isEndOfSong 是否已播到最后一行的末尾
 */
export function getPosYSpringPolicy(
  isSeeking: boolean,
  isInterlude: boolean,
  intervalMs?: number,
  isEndOfSong = false,
): Partial<SpringParams> {
  if (isSeeking || isInterlude) return { stiffness: SLOW_STIFFNESS, damping: SLOW_DAMPING };
  if (isEndOfSong) return { stiffness: MEDIUM_STIFFNESS, damping: MEDIUM_DAMPING };
  if (intervalMs == null) return { stiffness: SLOW_STIFFNESS, damping: SLOW_DAMPING };

  const clamped = Math.min(Math.max(intervalMs, MIN_INTERVAL), MAX_INTERVAL);
  // 间隔越短 ratio 越大（越快）；开五次方根让大间隔也保持偏快的刚度
  const ratio = (1 - (clamped - MIN_INTERVAL) / (MAX_INTERVAL - MIN_INTERVAL)) ** INTERVAL_EXPONENT;
  const stiffness = MIN_STIFFNESS + ratio * (MAX_STIFFNESS - MIN_STIFFNESS);
  return { stiffness, damping: Math.sqrt(stiffness) * DAMPING_MULTIPLIER };
}
