import { ChangeDetectionStrategy, Component, ElementRef, Renderer2, ViewChild, signal, effect, inject, AfterViewInit, ViewEncapsulation, HostListener, PLATFORM_ID } from '@angular/core';
import { animate, type AnimationOptions } from 'motion';
import { IGWTService } from './services/igwt.service';
import { CommonModule, isPlatformBrowser } from '@angular/common';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule],
  encapsulation: ViewEncapsulation.ShadowDom,
  templateUrl: './app.html',
  styleUrl: './styles.shadow.css'
})
export class App implements AfterViewInit {
  private renderer = inject(Renderer2);
  public igwt = inject(IGWTService);
  private platformId = inject(PLATFORM_ID);
  
  @ViewChild('modal') modalRef!: ElementRef<HTMLDivElement>;
  @ViewChild('gameCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  view = signal<'intro' | 'arcade' | 'playing' | 'postgame' | 'showcase' | 'idle'>('idle');
  currentGame = signal<'runner' | 'racer' | 'rhythm' | 'shooter' | null>(null);
  gamePhase = signal<'countdown' | 'active' | 'finished'>('active');
  countdown = signal(3);
  
  simulatingCheckoutUrl = signal<string | null>(null);
  
  private audioCtx: AudioContext | null = null;

  score = signal(0);
  coinsEarnedThisGame = signal(0);
  gemsEarned = signal(0);

  private initAudio() {
    if (!this.audioCtx && isPlatformBrowser(this.platformId)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Win = window as any;
        const AudioCtx = Win.AudioContext || Win.webkitAudioContext;
        if (AudioCtx) {
          this.audioCtx = new AudioCtx();
        }
      } catch {
        // Audio context initialization failed
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  private playPewSound() {
    if (!this.audioCtx) return;
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, this.audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, this.audioCtx.currentTime + 0.1);
    
    gain.gain.setValueAtTime(0.1, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.1);
    
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    osc.start();
    osc.stop(this.audioCtx.currentTime + 0.1);
  }
  strikes = signal(0);
  timer = signal(45);
  totalCoins = signal(0); // This will sync with igwt.state().coins
  
  // State variables for the 3-round sequence & custom anti-scoring difficulty engine
  currentRound = signal(1);
  roundCoinsEarned = signal(0);
  totalCoinsAccumulated = signal(0);
  
  private lastTime = 0;
  private animFrameId: number | null = null;
  private mouseX = 600;
  private isMouseDown = false;
  keys: Record<string, boolean> = {};

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) { this.keys[e.key] = true; }

  @HostListener('window:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent) { this.keys[e.key] = false; }

  // Game specific state
  private grid: number[][] = [];
  private selectedCell: {r: number, c: number} | null = null;
  private match3Anim: { r: number, c: number, type: string, frame: number, tr: number, tc: number, onComplete: () => void }[] = [];
  
  // Entities
  private player = { x: 600, y: 750, w: 60, h: 60, vx: 0, vy: 0, lane: 1, jumping: false, dir: 1 };
  private coins: { x: number, y: number, w: number, h: number, vx?: number, vy: number, spin: number, type?: 'coin' | 'gem' }[] = [];
  private obstacles: { type: string, x: number, y: number, vx?: number, vy: number, w: number, h: number, lastShot?: number }[] = [];
  private scenery: { x: number, y: number, type: 'tree' | 'pillar' }[] = [];
  private bullets: { x: number, y: number, vx: number, vy: number, w: number, h: number, color: string, isEnemy?: boolean }[] = [];
  private rhythmTargets: { x: number, y: number, w: number, h: number, speed: number }[] = [];
  private frameCount = 0;
  private roadOffset = 0;
  private distance = 0;
  private finishLine = 10000; // Finish after 10000 units of movement

  private animationOptions: AnimationOptions = { duration: 0.8, ease: [0.22, 1, 0.36, 1] };

  constructor() {
    effect(() => {
      const state = this.igwt.state();
      this.totalCoins.set(state.coins);
      this.totalCoinsAccumulated.set(state.coins);
      this.currentRound.set(Math.min(3, state.attemptsToday + 1));
    });

    this.igwt.checkServerTime();
  }

  ngAfterViewInit() {
    this.launchIntro();
  }

  private launchIntro() {
    this.view.set('intro');
  }

  enterTheForge() {
    if (this.igwt.state().isLocked) return;
    this.view.set('arcade');
  }

  selectGame(game: 'runner' | 'racer' | 'rhythm' | 'shooter') {
    if (this.igwt.state().isLocked) return;
    
    // Dynamic difficulty tracking variables
    const attempts = this.igwt.state().attemptsToday;
    if (attempts === 0) {
      this.totalCoinsAccumulated.set(0);
    } else {
      this.totalCoinsAccumulated.set(this.igwt.state().coins);
    }
    this.currentRound.set(Math.min(3, attempts + 1));
    this.roundCoinsEarned.set(0);
    
    this.currentGame.set(game);
    this.view.set('playing');
    this.gamePhase.set((game === 'racer' || game === 'runner') ? 'countdown' : 'active');
    this.countdown.set(3);
    this.score.set(0);
    this.coinsEarnedThisGame.set(0);
    this.gemsEarned.set(0);
    this.strikes.set(0);
    this.timer.set(45);
    
    // Initializing player position based on game mode
    if (game === 'shooter') {
        this.player = { x: 570, y: 630, w: 60, h: 80, vx: 0, vy: 0, lane: 1, jumping: false, dir: 1 };
    } else if (game === 'runner') {
        this.player = { x: 600, y: 650, w: 70, h: 90, vx: 0, vy: 0, lane: 1, jumping: false, dir: 1 }; 
    } else if (game === 'racer') {
        this.player = { x: 570, y: 500, w: 80, h: 120, vx: 0, vy: 0, lane: 1, jumping: false, dir: 1 };
    } else {
        this.player = { x: 600, y: 700, w: 50, h: 50, vx: 0, vy: 0, lane: 1, jumping: false, dir: 1 };
        this.initMatch3();
    }

    this.coins = [];
    this.obstacles = [];
    this.scenery = [];
    this.bullets = [];
    this.rhythmTargets = [];
    this.frameCount = 0;
    this.roadOffset = 0;
    this.distance = 0;

    if (game === 'racer') {
      // Beach scenery
      for(let i=0; i<10; i++) {
        this.scenery.push({ x: 50 + Math.random()*200, y: i * 200, type: 'tree' });
        this.scenery.push({ x: 950 + Math.random()*200, y: i * 200, type: 'tree' });
      }
    }
    
    if (this.gamePhase() === 'countdown') {
      const cd = setInterval(() => {
        if (this.countdown() > 1) {
          this.countdown.update(c => c - 1);
        } else {
          this.countdown.set(0);
          this.gamePhase.set('active');
          clearInterval(cd);
        }
      }, 1000);
    }
    
    setTimeout(() => this.initGameEngine(), 100);
  }

  minimizeToEdge() {
    const modal = this.modalRef.nativeElement;
    animate(modal, { scale: 0.1, opacity: 0, x: '45vw', y: '0vh', rotate: 15 }, 
      { ...this.animationOptions, onComplete: () => {
        this.view.set('idle');
        if (typeof window !== 'undefined' && window.parent) {
          window.parent.postMessage({ type: 'igwt_collapse' }, '*');
        }
      }});
  }

  restoreFromEdge() {
    if (typeof window !== 'undefined' && window.parent) {
      window.parent.postMessage({ type: 'igwt_expand' }, '*');
    }
    if (this.igwt.state().attemptsToday === 0) {
      this.view.set('intro');
    } else {
      this.view.set('arcade');
    }
    setTimeout(() => {
      const modal = this.modalRef.nativeElement;
      if (modal) {
        animate(modal, { scale: [0.1, 1], opacity: [0, 1], x: ['45vw', '0vw'], y: ['0vh', '0vh'], rotate: [15, 0] }, this.animationOptions);
      }
    }, 50);
  }

  onMouseMove(e: MouseEvent) {
    if (!this.canvasRef || this.view() !== 'playing') return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const scaleX = 1200 / rect.width;
    this.mouseX = (e.clientX - rect.left) * scaleX;
    
    if (this.currentGame() === 'racer' || this.currentGame() === 'runner') {
      this.player.x = this.mouseX - this.player.w / 2;
      this.player.x = Math.max(0, Math.min(1200 - this.player.w, this.player.x));
    }
  }

  private lastTapTime = 0;
  private touchStartX = 0;
  private touchStartY = 0;
  private aimY = 0; // for shooter looking up/down

  onTouchStart(e: TouchEvent) {
    this.isMouseDown = true;
    if (e.touches.length > 0) {
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
      this.onTouchMove(e);
      this.handleTap(e.touches[0].clientX, e.touches[0].clientY);
    }
  }

  onTouchEnd(e: TouchEvent) {
    this.isMouseDown = false;
    if (this.currentGame() === 'shooter') {
        this.keys['ArrowLeft'] = false;
        this.keys['ArrowRight'] = false;
    }
    
    // Check for swipe if in runner or shooter
    if (e.changedTouches.length > 0) {
      const dx = e.changedTouches[0].clientX - this.touchStartX;
      const dy = e.changedTouches[0].clientY - this.touchStartY;
      
      if (this.currentGame() === 'runner') {
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx > 30) this.player.lane = Math.min(2, this.player.lane + 1);
          else if (dx < -30) this.player.lane = Math.max(0, this.player.lane - 1);
        } else {
          if (dy < -30 && this.player.y >= 650) {
            this.player.vy = -18;
          } else if (dy > 30) {
            this.player.jumping = false; 
            this.player.h = 25;
            setTimeout(() => this.player.h = 50, 1000); 
          }
        }
      } else if (this.currentGame() === 'shooter') {
        if (dy < -30 && !this.player.jumping) {
           this.player.vy = -18;
           this.player.jumping = true;
        } else if (dy > 30) {
           this.player.h = 30; // duck
           setTimeout(() => this.player.h = 60, 1000); 
        }
      }
    }
  }

  onTouchMove(e: TouchEvent) {
    if (e.touches.length > 0) {
      e.preventDefault(); // prevent scrolling
      if (!this.canvasRef || this.view() !== 'playing') return;
      const rect = this.canvasRef.nativeElement.getBoundingClientRect();
      const scaleX = 1200 / rect.width;
      const scaleY = 800 / rect.height;
      this.mouseX = (e.touches[0].clientX - rect.left) * scaleX;
      
      if (this.currentGame() === 'racer' || this.currentGame() === 'runner') {
        // Touch steering maps directly to position
        this.player.x = this.mouseX - this.player.w / 2;
        if (this.currentGame() === 'racer') {
          this.player.x = Math.max(250, Math.min(950 - this.player.w, this.player.x));
        } else {
          this.player.x = Math.max(350 + 10, Math.min(850 - 10 - this.player.w, this.player.x));
        }
      } else if (this.currentGame() === 'shooter') {
        const my = (e.touches[0].clientY - rect.top) * scaleY;
        this.aimY = my - (this.player.y + this.player.h/2);

        // Touch left/right side to move
        if (this.mouseX < 300) { this.keys['ArrowLeft'] = true; this.keys['ArrowRight'] = false; }
        else if (this.mouseX > 900) { this.keys['ArrowRight'] = true; this.keys['ArrowLeft'] = false; }
        else { this.keys['ArrowLeft'] = false; this.keys['ArrowRight'] = false; }
      }
    }
  }

  onMouseDown(e: MouseEvent) { 
    this.isMouseDown = true;
    if (this.canvasRef && this.view() === 'playing') {
      const rect = this.canvasRef.nativeElement.getBoundingClientRect();
      const scaleY = 800 / rect.height;
      const my = (e.clientY - rect.top) * scaleY;
      this.aimY = my - (this.player.y + this.player.h/2);
    }
  }

  onMouseUp() { 
    this.isMouseDown = false; 
    if (this.currentGame() === 'shooter') {
        this.keys['ArrowLeft'] = false;
        this.keys['ArrowRight'] = false;
    }
  }

  handleCanvasClick(e: MouseEvent) {
    this.handleTap(e.clientX, e.clientY);
  }

  // Match3 logic initialization
  private initMatch3() {
    this.grid = [];
    for(let r=0; r<8; r++) {
      this.grid[r] = [];
      for(let c=0; c<8; c++) {
        this.grid[r][c] = Math.floor(Math.random() * 5);
      }
    }
  }

  handleTap(clientX: number, clientY: number) {
    this.initAudio();
    if (this.view() !== 'playing') return;
    
    const now = performance.now();
    const isDoubleTap = now - this.lastTapTime < 350;
    this.lastTapTime = now;

    if (this.currentGame() === 'shooter') {
      if (this.player.y >= 550) {
        this.player.vy = -20; // Jump
        this.player.jumping = true;
      }
    } else if (this.currentGame() === 'runner' && isDoubleTap) {
        this.player.jumping = true; // Use jumping to mean 'has hoverboard'
    } else if (this.currentGame() === 'rhythm') {
      const rect = this.canvasRef.nativeElement.getBoundingClientRect();
      const scaleX = 1200 / rect.width;
      const scaleY = 800 / rect.height;
      const x = (clientX - rect.left) * scaleX;
      const y = (clientY - rect.top) * scaleY;
      
      const col = Math.floor((x - 400) / 50);
      const row = Math.floor((y - 200) / 50);
      
      if (col >= 0 && col < 8 && row >= 0 && row < 8) {
        if (!this.selectedCell) {
          this.selectedCell = { r: row, c: col };
        } else {
          // Swap adjacent
          const dr = Math.abs(this.selectedCell.r - row);
          const dc = Math.abs(this.selectedCell.c - col);
          if (dr + dc === 1) {
            const sr = this.selectedCell.r;
            const sc = this.selectedCell.c;
            const temp = this.grid[row][col];
            this.grid[row][col] = this.grid[sr][sc];
            this.grid[sr][sc] = temp;
            
            const matched = this.checkMatches();
            if (matched === 0) {
              // Swap back
              this.grid[sr][sc] = this.grid[row][col];
              this.grid[row][col] = temp;
            }
          }
          this.selectedCell = null;
        }
      }
    } else if (this.currentGame() === 'runner') {
      if (clientX < window.innerWidth / 2) {
        this.player.lane = Math.max(0, this.player.lane - 1);
      } else {
        this.player.lane = Math.min(2, this.player.lane + 1);
      }
    }
  }

  private checkMatches(): number {
    const toPop = new Set<string>();
    
    // Horizontal
    for (let r = 0; r < 8; r++) {
      let matchCount = 1;
      for (let c = 0; c < 7; c++) {
        if (this.grid[r][c] !== -1 && this.grid[r][c] === this.grid[r][c+1]) {
          matchCount++;
        } else {
          if (matchCount >= 3) {
            for (let i = 0; i < matchCount; i++) toPop.add(`${r},${c-i}`);
          }
          matchCount = 1;
        }
      }
      if (matchCount >= 3) {
        for (let i = 0; i < matchCount; i++) toPop.add(`${r},${7-i}`);
      }
    }
    
    // Vertical
    for (let c = 0; c < 8; c++) {
      let matchCount = 1;
      for (let r = 0; r < 7; r++) {
        if (this.grid[r][c] !== -1 && this.grid[r][c] === this.grid[r+1][c]) {
          matchCount++;
        } else {
          if (matchCount >= 3) {
            for (let i = 0; i < matchCount; i++) toPop.add(`${r-i},${c}`);
          }
          matchCount = 1;
        }
      }
      if (matchCount >= 3) {
        for (let i = 0; i < matchCount; i++) toPop.add(`${7-i},${c}`);
      }
    }

    if (toPop.size > 0) {
      toPop.forEach(pos => {
        const [r, c] = pos.split(',').map(Number);
        this.grid[r][c] = -1;
      });
      this.score.update(s => s + toPop.size * 50);
      setTimeout(() => this.applyGravityMatch3(), 300);
      return toPop.size;
    }
    return 0;
  }

  private applyGravityMatch3() {
    let changed = false;
    for (let c = 0; c < 8; c++) {
      let writeRow = 7;
      for (let r = 7; r >= 0; r--) {
        if (this.grid[r][c] !== -1) {
          if (writeRow !== r) {
             this.grid[writeRow][c] = this.grid[r][c];
             this.grid[r][c] = -1;
             changed = true;
          }
          writeRow--;
        }
      }
      for (let r = writeRow; r >= 0; r--) {
        this.grid[r][c] = Math.floor(Math.random() * 5); // refill generic new color
        changed = true;
      }
    }
    
    if (changed) {
       setTimeout(() => this.checkMatches(), 400); // Check for cascades
    }
  }

  private initGameEngine() {
    if (!this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d')!;
    this.lastTime = performance.now();

    const loop = (now: number) => {
      if (this.view() !== 'playing') return;
      
      const dt = now - this.lastTime;
      this.lastTime = now;

      const mode = this.currentGame();
      const newTimer = mode === 'shooter' ? this.timer() : Math.max(0, this.timer() - dt / 1000);
      this.timer.set(newTimer);

      if (this.timer() <= 0 && mode !== 'shooter') {
        this.finishGame();
        return;
      }

      this.frameCount++;
      this.updateLogic(dt);
      this.renderGame(ctx);
      
      this.animFrameId = requestAnimationFrame(loop);
    };
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.animFrameId = requestAnimationFrame(loop);
  }

  getDifficultyModifiers() {
    const round = Math.min(3, this.currentRound());
    const coins = this.roundCoinsEarned();
    
    let speedMult = 1.0;
    let sizeMult = 1.0;
    let trapSpawnMult = 1.0;

    // 1. Baseline Round Modifiers
    if (round === 2) {
        speedMult *= 1.30;      // increases game asset speeds by 30%
        sizeMult *= 0.85;       // shrinks targets by 15%
    } else if (round >= 3) {
        speedMult *= 1.60;      // increases baseline speeds by 60%
        sizeMult *= 0.70;       // shrinks targets by 30%
        trapSpawnMult *= 1.50;  // increases trap/obstacle spawn frequency by 50%
    }

    // 2. The 20-Coin Warning Zone
    if (coins >= 20 && coins < 30) {
        speedMult *= 1.40;      // immediately scale asset travel speeds up by an additional 40%
        sizeMult *= 0.80;       // shrink hitboxes by 20%
    }
    
    // 3. The 30-Coin Hard Wall
    if (coins >= 30) {
        speedMult *= 2.0;       // instantly double all target speeds
        trapSpawnMult *= 2.0;   // double trap spawn rates
        sizeMult *= 0.15;       // shrink target sizes to tiny, near-unclickable elements
    }

    return { speedMult, sizeMult, trapSpawnMult };
  }

  // Logic
  private updateLogic(dt: number) {
    const mode = this.currentGame();
    if (this.gamePhase() === 'countdown') return;
    
    // Dynamically update the current round coins earned based on score
    this.roundCoinsEarned.set(Math.floor(this.score() / 10));
    
    const timeScale = dt / 16.666; 
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    
    const mods = this.getDifficultyModifiers();
    const activeTimeScale = timeScale * mods.speedMult;
    
    this.frameCount++;
    
    if (mode === 'shooter') {
      // Shooter Platformer Movement
      if (this.keys['ArrowLeft']) { this.player.vx = -8; this.player.dir = -1; }
      else if (this.keys['ArrowRight']) { this.player.vx = 8; this.player.dir = 1; }
      else this.player.vx *= 0.8;
      
      if ((this.keys['ArrowUp'] || this.keys[' ']) && !this.player.jumping) {
        this.player.vy = -20;
        this.player.jumping = true;
      }
      if (this.keys['ArrowDown']) {
        this.player.h = 35; // duck
      } else {
        this.player.h = 70;
      }
      
      this.player.vy += 1.0 * timeScale; // Gravity
      this.player.x += this.player.vx * activeTimeScale;
      this.player.y += this.player.vy * activeTimeScale;
      
      const groundLevelY = canvas.height - 100;
      if (this.player.y > (groundLevelY - this.player.h)) {
        this.player.y = (groundLevelY - this.player.h);
        this.player.vy = 0;
        this.player.jumping = false;
      }
      this.player.x = Math.max(300, Math.min(900 - this.player.w, this.player.x));

      // Shooting logic
      if ((this.isMouseDown || this.keys['Shoot']) && this.frameCount % 8 === 0) {
        // Aiming
        let shootVy = 0;
        if (this.aimY < -50) shootVy = -5;
        else if (this.aimY > 50) shootVy = 5;

        this.bullets.push({ 
          x: this.player.x + (this.player.dir === 1 ? this.player.w : -12), 
          y: this.player.y + 25, 
          vx: this.player.dir * 18, 
          vy: shootVy, 
          w: 12, h: 6, color: '#ff8c00', isEnemy: false
        });
        this.playPewSound();
      }

      // Enemies
      if (Math.random() < 0.04 * timeScale * mods.trapSpawnMult) {
        const side = Math.random() < 0.5 ? -100 : 1300;
        const speed = side < 0 ? 3.5 : -3.5;
        const isBoss = Math.random() < 0.1;
        this.obstacles.push({
          type: isBoss ? 'boss' : 'alien',
          x: side, y: groundLevelY - (isBoss ? 120 : 70),
          vx: speed + (Math.random()*2 - 1),
          vy: 0, 
          w: (isBoss ? 100 : 50) * mods.sizeMult, 
          h: (isBoss ? 120 : 70) * mods.sizeMult,
          lastShot: this.frameCount
        });
      }
      
      // Enemies shoot back & fall handling
      for (let j = this.obstacles.length - 1; j >= 0; j--) {
        const o = this.obstacles[j];
        if (o.type === 'alien' || o.type === 'boss') {
           if (o.vy !== 0) { // Dying
              o.vy += 0.8 * activeTimeScale;
              if (o.y > canvas.height + 100) this.obstacles.splice(j, 1);
              continue;
           }

           const shotDelay = o.type === 'boss' ? 50 : 80;
           if ((this.frameCount - (o.lastShot || 0)) > shotDelay && Math.random() < 0.04) {
              o.lastShot = this.frameCount;
              const dirX = (this.player.x < o.x) ? -1 : 1;
              this.bullets.push({
                x: o.x + (dirX === 1 ? o.w : -12),
                y: o.y + 25,
                vx: dirX * (o.type === 'boss' ? 12 : 10),
                vy: (this.player.y - o.y) * 0.02,
                w: 12 * mods.sizeMult, h: 6 * mods.sizeMult, color: o.type === 'boss' ? '#f43f5e' : '#ef4444', isEnemy: true
              });
           }
        }
      }
    } else if (mode === 'runner') {
      if (this.keys['ArrowLeft']) this.player.x -= 10 * activeTimeScale;
      if (this.keys['ArrowRight']) this.player.x += 10 * activeTimeScale;
      this.player.x = Math.max(350 + 10, Math.min(850 - 10 - this.player.w, this.player.x));
      
      if ((this.keys['ArrowUp'] || this.keys[' ']) && !this.player.jumping) {
        this.player.vy = -18;
        this.player.jumping = true;
      }
      if (this.keys['ArrowDown']) {
        this.player.h = 35; // Ducking
      } else {
        this.player.h = 60;
      }
      
      this.player.vy += 1.0 * timeScale; // Gravity
      this.player.y += this.player.vy * activeTimeScale;
      
      if (this.player.y > (630)) {
        this.player.y = 630;
        this.player.vy = 0;
        this.player.jumping = false;
      }

      if (Math.random() < 0.05 * timeScale * mods.trapSpawnMult) {
        this.coins.push({ x: 350 + 20 + Math.random() * (500 - 40 - 40), y: -80, vy: 10 + (this.frameCount/1000), w: 40 * mods.sizeMult, h: 40 * mods.sizeMult, spin: 0 });
      }
      if (Math.random() < 0.04 * timeScale * mods.trapSpawnMult) {
        const type = Math.random() < 0.4 ? 'barrier' : 'train';
        this.obstacles.push({ 
          type, 
          x: 350 + 20 + Math.random() * (500 - 80 - 40), y: -200, 
          vy: (type === 'train' ? 14 : 10) + (this.frameCount/800), 
          w: 80 * mods.sizeMult, 
          h: (type === 'train' ? 180 : 40) * mods.sizeMult 
        });
      }
    } else if (mode === 'racer') {
      if (this.keys['ArrowLeft']) this.player.x -= 12 * activeTimeScale;
      if (this.keys['ArrowRight']) this.player.x += 12 * activeTimeScale;
      this.player.x = Math.max(250, Math.min(950 - this.player.w, this.player.x));
      
      if ((this.keys['ArrowUp'] || this.keys[' ']) && !this.player.jumping) {
        this.player.vy = -18;
        this.player.jumping = true;
      }
      this.player.vy += 1.0 * timeScale; // Gravity
      this.player.y += this.player.vy * activeTimeScale;
      
      const baseRacerY = 500;
      if (this.player.y > baseRacerY) {
        this.player.y = baseRacerY;
        this.player.vy = 0;
        this.player.jumping = false;
      }
      
      this.roadOffset = (this.roadOffset + 18 * activeTimeScale) % 100;
      this.distance += 18 * activeTimeScale;
      
      if (this.distance > this.finishLine && this.gamePhase() === 'active') {
        this.gamePhase.set('finished');
        setTimeout(() => this.finishGame(), 2000);
      }
      
      // Scenery movement
      this.scenery.forEach(s => {
        s.y += 18 * activeTimeScale;
        if (s.y > 800) {
          s.y = -200;
          s.x = s.x < 600 ? 50 + Math.random()*200 : 950 + Math.random()*200;
        }
      });

      if (Math.random() < 0.08 * timeScale * mods.trapSpawnMult) {
        const x = 600 + (Math.random() - 0.5) * 450;
        const isGem = Math.random() < 0.1;
        this.coins.push({ 
          x, y: -80, vy: 18, w: 40 * mods.sizeMult, h: 40 * mods.sizeMult, spin: 0, 
          type: isGem ? 'gem' : 'coin' 
        });
      }
      
      if (Math.random() < 0.05 * timeScale * mods.trapSpawnMult) {
        const x = 600 + (Math.random() - 0.5) * 450;
        const types = ['pillar', 'car', 'trailer', 'lorry', 'van', 'bus', 'bicycle', 'motorcycle'];
        const type = types[Math.floor(Math.random() * types.length)];
        let w = 60, h = 110, vy = 8;
        if (type === 'pillar') { w = 40; h = 80; vy = 18; }
        else if (type === 'trailer') { w = 80; h = 250; vy = 6; }
        else if (type === 'lorry') { w = 80; h = 180; vy = 7; }
        else if (type === 'van') { w = 65; h = 130; vy = 7; }
        else if (type === 'bus') { w = 80; h = 200; vy = 6.5; }
        else if (type === 'bicycle') { w = 30; h = 60; vy = 4; }
        else if (type === 'motorcycle') { w = 40; h = 80; vy = 10; }
        
        this.obstacles.push({ type, x, y: -250, vy, w: w * mods.sizeMult, h: h * mods.sizeMult });
      }
    }

    // Movement updates
    this.bullets.forEach(b => { 
        b.x += (b.vx || 0) * activeTimeScale; 
        b.y += (b.vy || 0) * activeTimeScale; 
    });
    this.coins.forEach(c => { 
        c.y += (c.vy || 0) * activeTimeScale; 
        c.x += (c.vx || 0) * activeTimeScale;
        c.spin += 0.15 * activeTimeScale;
    });
    this.obstacles.forEach(o => { 
        o.y += (o.vy || 0) * activeTimeScale; 
        o.x += (o.vx || 0) * activeTimeScale; 
    });

    // Collisions
    if (mode === 'shooter') {
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        let hit = false;
        
        if (b.isEnemy) {
          if (Math.hypot((b.x+b.w/2) - (this.player.x+this.player.w/2), (b.y+b.h/2) - (this.player.y+this.player.h/2)) < 30) {
            this.strikes.update(s => s + 1);
            hit = true;
            if (this.strikes() >= 3) this.finishGame();
          }
        } else {
          for (let j = this.obstacles.length - 1; j >= 0; j--) {
            const o = this.obstacles[j];
            if (o.vy === 0 && Math.hypot((b.x+b.w/2) - (o.x+o.w/2), (b.y+b.h/2) - (o.y+o.h/2)) < 40) {
              this.score.update(s => s + 100);
              o.vy = -5; // Start falling
              o.vx = (Math.random() - 0.5) * 4;
              hit = true; break;
            }
          }
        }
        if (hit) this.bullets.splice(i, 1);
      }
      
      for (let j = this.obstacles.length - 1; j >= 0; j--) {
        const o = this.obstacles[j];
        if (o.vy === 0 && Math.hypot((o.x + o.w/2) - (this.player.x + this.player.w/2), (o.y + o.h/2) - (this.player.y + this.player.h/2)) < 40) {
           this.strikes.update(s => s + 1);
           o.vy = -5; o.vx = (o.x > this.player.x ? 5 : -5); // pop enemy away
           if (this.strikes() >= 3) this.finishGame();
        }
      }
    } else if (mode === 'runner' || mode === 'racer') {
       const px = this.player.x, py = this.player.y, pw = this.player.w, ph = this.player.h;
       
       for (let j = this.coins.length - 1; j >= 0; j--) {
          const c = this.coins[j];
          if (px < c.x + c.w && px + pw > c.x && py < c.y + c.h && py + ph > c.y) {
            this.score.update(s => s + 100);
            this.coins.splice(j, 1);
          }
        }
        
        for (let j = this.obstacles.length - 1; j >= 0; j--) {
          const o = this.obstacles[j];
          if (px < o.x + o.w && px + pw > o.x && py < o.y + o.h && py + ph > o.y) {
            if ((mode === 'runner' || mode === 'racer') && this.player.jumping) {
              if (mode === 'runner') this.player.jumping = false; // hoverboard breaks
              // racer flies over
            } else {
              this.strikes.update(s => s + 1);
              this.obstacles.splice(j, 1);
              if (this.strikes() >= 3) this.finishGame();
            }
          }
        }
        
        if (mode === 'racer') {
            const trackWidth = 500; 
            if (px < 600 - trackWidth/2 || px + pw > 600 + trackWidth/2) {
                if (this.frameCount % 90 === 0) {
                    this.strikes.update(s => s + 1);
                    if (this.strikes() >= 3) this.finishGame();
                }
            }
        }
    }

    this.bullets = this.bullets.filter(b => b.y > -50 && b.y < 850 && b.x > -50 && b.x < 1250);
    this.coins = this.coins.filter(c => c.y < 850);
    this.obstacles = this.obstacles.filter(o => o.y < 950 && o.x > -200 && o.x < 1400);
  }

  // Rendering
  private renderGame(ctx: CanvasRenderingContext2D) {
    const w = 1200, h = 800;
    ctx.clearRect(0, 0, w, h);
    const mode = this.currentGame();

    if (mode === 'rhythm') {
      // Puzzle grid Candy Crush style
      const pColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
      ctx.save();
      
      // Puzzle Buddy
      ctx.save();
      ctx.translate(200, 400);
      const buddyBob = Math.sin(this.frameCount * 0.1) * 10;
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath(); ctx.roundRect(-40, -50 + buddyBob, 80, 100, 30); ctx.fill();
      // Eyes
      ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(-15, -20 + buddyBob, 10, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(15, -20 + buddyBob, 10, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.arc(-12, -18 + buddyBob, 4, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(18, -18 + buddyBob, 4, 0, Math.PI*2); ctx.fill();
      // Mouth
      ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 10 + buddyBob, 15, 0, Math.PI, false); ctx.stroke();
      ctx.restore();

      ctx.translate(400, 200);
      
      // Board bg
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(0,0,0,0.1)';
      ctx.beginPath();
      ctx.roundRect(-10, -10, 420, 420, 15);
      ctx.fill();
      
      for(let r=0; r<8; r++) {
        for(let c=0; c<8; c++) {
          const colorCode = this.grid[r][c];
          if (colorCode !== -1) {
            ctx.save();
            ctx.translate(c * 50 + 25, r * 50 + 25);
            
            // Candy Shape
            ctx.fillStyle = pColors[colorCode];
            ctx.beginPath();
            ctx.arc(0, 0, 22, 0, Math.PI*2);
            ctx.fill();
            
            // Gloss effect
            const gradient = ctx.createRadialGradient(-7, -7, 2, -5, -5, 12);
            gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
            gradient.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(0, 0, 22, 0, Math.PI*2);
            ctx.fill();

            if (this.selectedCell && this.selectedCell.r === r && this.selectedCell.c === c) {
              ctx.strokeStyle = 'white';
              ctx.lineWidth = 4;
              ctx.stroke();
              ctx.shadowBlur = 15;
              ctx.shadowColor = 'white';
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      }
      ctx.restore();
    } else {
      // Perspective Road / Environment
      if (mode === 'racer') {
        ctx.save();
        // Sky Morning Beach
        const skyGrd = ctx.createLinearGradient(0, 0, 0, 300);
        skyGrd.addColorStop(0, '#7dd3fc'); // Sky blue
        skyGrd.addColorStop(1, '#ffedd5'); // Morning orange-ish
        ctx.fillStyle = skyGrd;
        ctx.fillRect(0, 0, w, 400);
        
        // Ocean
        ctx.fillStyle = '#0ea5e9';
        ctx.fillRect(0, 350, w, 150);
        
        // Sand
        ctx.fillStyle = '#fef08a';
        ctx.fillRect(0, 450, w, h-450);
        
        // Road Asphalt Nitro style
        ctx.fillStyle = '#1e293b';
        ctx.beginPath(); ctx.moveTo(w/2 - 100, 380); ctx.lineTo(w/2 + 100, 380); ctx.lineTo(w/2 + 500, h); ctx.lineTo(w/2 - 500, h); ctx.fill();
        
        // Sidelines
        ctx.strokeStyle = '#facc15'; ctx.lineWidth = 15;
        ctx.beginPath(); ctx.moveTo(w/2-105, 380); ctx.lineTo(w/2-515, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w/2+105, 380); ctx.lineTo(w/2+515, h); ctx.stroke();

        ctx.strokeStyle = 'white'; ctx.lineWidth = 8; ctx.setLineDash([60, 60]); ctx.lineDashOffset = -this.roadOffset * 5;
        ctx.beginPath(); ctx.moveTo(w/2, 380); ctx.lineTo(w/2, h); ctx.stroke();
        
        // Scenery (Trees)
        this.scenery.forEach(s => {
          if (s.type === 'tree') {
             ctx.save();
             ctx.translate(s.x, s.y);
             // Trunk
             ctx.fillStyle = '#713f12';
             ctx.fillRect(-5, 0, 10, 40);
             // Leaves (Coconut tree style)
             ctx.fillStyle = '#166534';
             for(let i=0; i<6; i++) {
               ctx.rotate(Math.PI/3);
               ctx.beginPath(); ctx.ellipse(15, 0, 20, 5, 0, 0, Math.PI*2); ctx.fill();
             }
             ctx.restore();
          }
        });

        // Finish Line
        if (this.distance > this.finishLine - 1000) {
           const fy = 400 - (this.distance - (this.finishLine - 1000));
           if (fy > 0) {
             ctx.fillStyle = 'white';
             ctx.fillRect(w/2 - 300, fy, 600, 40);
             ctx.fillStyle = '#1e293b';
             for(let i=0; i<12; i++) {
               if (i % 2 === 0) ctx.fillRect(w/2 - 300 + i*50, fy, 25, 20);
               else ctx.fillRect(w/2 - 300 + i*50 + 25, fy+20, 25, 20);
             }
           }
        }
        
        ctx.restore();
      } else if (mode === 'runner') {
        ctx.save();
        // Temple/Tunnel Walls
        ctx.fillStyle = '#451a03'; ctx.fillRect(0,0,w,h);
        ctx.fillStyle = '#78350f'; ctx.fillRect(350, 0, 500, h); 
        
        // Perspective lines
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2;
        for(let i=0; i<h; i+=50) {
           const y = (i + this.frameCount * 5) % h;
           ctx.beginPath(); ctx.moveTo(350, y); ctx.lineTo(850, y); ctx.stroke();
        }
        
        ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(550, 0); ctx.lineTo(550, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(750, 0); ctx.lineTo(750, h); ctx.stroke();
        ctx.restore();
      } else if (mode === 'shooter') {
        const offset = (this.frameCount * 5) % 100;
        ctx.fillStyle = '#0f172a'; ctx.fillRect(0,0,w,h);
        ctx.strokeStyle = 'rgba(212,175,55,0.1)'; ctx.lineWidth = 1;
        for (let i=-100; i<=h; i+=100) { ctx.beginPath(); ctx.moveTo(0, i+offset); ctx.lineTo(w, i+offset); ctx.stroke(); }
        // Floor at bottom
        const groundY = h - 100;
        ctx.fillStyle = '#1e293b'; ctx.fillRect(0, groundY, w, 100);
        ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(w, groundY); ctx.stroke();
      }

      // Draw Coins / Gems
      this.coins.forEach(c => {
        ctx.save();
        ctx.translate(c.x + c.w/2, c.y + c.h/2);
        ctx.scale(Math.cos(c.spin), 1);
        
        if (c.type === 'gem') {
          ctx.fillStyle = '#06b6d4';
          ctx.beginPath();
          ctx.moveTo(0, -c.h/2);
          ctx.lineTo(c.w/2, 0);
          ctx.lineTo(0, c.h/2);
          ctx.lineTo(-c.w/2, 0);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
        } else {
          ctx.fillStyle = '#fbbf24';
          ctx.beginPath(); ctx.arc(0, 0, c.w/2, 0, Math.PI*2); ctx.fill();
          ctx.strokeStyle = '#b45309'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.font = 'bold 24px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('$', 0, 0);
        }
        ctx.restore();
      });

      // Draw Obstacles
      this.obstacles.forEach(o => {
        ctx.save();
        if (o.type === 'alien' || o.type === 'boss') {
          ctx.save();
          ctx.translate(o.x + o.w/2, o.y + o.h/2);
          
          if (o.vy !== 0) {
            ctx.rotate(this.frameCount * 0.1);
          }

          const walkCycle = o.vy === 0 ? Math.sin(this.frameCount * 0.2) * 12 : 0;
          
          if (o.type === 'boss') {
            // Boss details
            ctx.fillStyle = '#991b1b';
            ctx.beginPath(); ctx.moveTo(-50, -60); ctx.lineTo(50, -60); ctx.lineTo(0, -90); ctx.closePath(); ctx.fill();
          }

          // Antenna
          ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(0, -35); ctx.lineTo(0, -45); ctx.stroke();
          ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(0, -45, 4, 0, Math.PI*2); ctx.fill();

          // Body
          ctx.fillStyle = o.type === 'boss' ? '#450a0a' : '#ef4444'; 
          ctx.beginPath(); ctx.roundRect(-o.w/2, -o.h/2, o.w, o.h, 25); ctx.fill();
          
          // Visor / Mask
          ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(-20, -25, 40, 25, 10); ctx.fill();

          // Eyes (Glowing)
          ctx.fillStyle = o.type === 'boss' ? '#fbbf24' : '#f87171'; 
          ctx.beginPath(); ctx.arc(-8, -12, 6, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(8, -12, 6, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(-8, -12, 2, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(8, -12, 2, 0, Math.PI*2); ctx.fill();
          
          // Armor Plate
          ctx.fillStyle = '#991b1b'; ctx.fillRect(-15, 10, 30, 5);

          // Legs
          ctx.fillStyle = '#450a0a'; 
          ctx.beginPath(); ctx.roundRect(-o.w/2 + 5, o.h/2 - 5 - walkCycle, 12, 25, 6); ctx.fill(); 
          ctx.beginPath(); ctx.roundRect(o.w/2 - 17, o.h/2 - 5 + walkCycle, 12, 25, 6); ctx.fill();
          
          ctx.restore();
        } else if (o.type === 'train') {
          ctx.fillStyle = '#b91c1c'; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 15); ctx.fill();
          ctx.fillStyle = '#1e293b'; ctx.fillRect(o.x + 10, o.y + 10, o.w - 20, 50);
          // Windows
          ctx.fillStyle = '#0ea5e9';
          for(let i=0; i<3; i++) ctx.fillRect(o.x + 15, o.y + 70 + i*40, o.w - 30, 25);
        } else if (o.type === 'barrier') {
          // Stripey barrier
          ctx.fillStyle = '#fbbf24'; ctx.fillRect(o.x, o.y, o.w, o.h);
          ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
          for(let i=0; i<o.w; i+=20) {
            ctx.beginPath(); ctx.moveTo(o.x+i, o.y); ctx.lineTo(o.x+i+10, o.y+o.h); ctx.stroke();
          }
          ctx.strokeRect(o.x, o.y, o.w, o.h);
        } else if (o.type === 'car') {
          // Opponent Rival Car
          ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 12); ctx.fill();
          // Stripe
          ctx.fillStyle = '#ef4444'; ctx.fillRect(o.x + o.w/2 - 5, o.y, 10, o.h);
          // Spoiler
          ctx.fillStyle = '#ef4444'; ctx.fillRect(o.x - 5, o.y + o.h - 15, o.w + 10, 8);
          // Windshield
          ctx.fillStyle = '#334155'; ctx.fillRect(o.x+8, o.y+15, o.w-16, 25);
        } else if (o.type === 'trailer' || o.type === 'lorry' || o.type === 'bus') {
          // Heavy vehicles
          ctx.fillStyle = o.type === 'bus' ? '#fbbf24' : '#64748b'; 
          ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 15); ctx.fill();
          if (o.type === 'trailer' || o.type === 'lorry') {
             ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.roundRect(o.x + 4, o.y + 4, o.w - 8, o.h - 50, 5); ctx.fill(); // Cargo
             ctx.fillStyle = '#0ea5e9'; ctx.beginPath(); ctx.roundRect(o.x + 10, o.y + o.h - 40, o.w - 20, 20, 5); ctx.fill(); // Windshield
          } else {
             // Bus windows
             ctx.fillStyle = '#0ea5e9';
             for(let i=10; i<o.h-40; i+=30) {
                ctx.beginPath(); ctx.roundRect(o.x + 5, o.y + i, o.w - 10, 20, 3); ctx.fill();
             }
             ctx.beginPath(); ctx.roundRect(o.x + 5, o.y + o.h - 30, o.w - 10, 20, 4); ctx.fill(); // Windshield
          }
        } else if (o.type === 'van') {
          ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 10); ctx.fill();
          ctx.fillStyle = '#cbd5e1'; ctx.fillRect(o.x + 5, o.y + 5, o.w - 10, o.h - 40); // Cargo area
          ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.roundRect(o.x + 5, o.y + o.h - 30, o.w - 10, 15, 4); ctx.fill(); // Windshield
        } else if (o.type === 'bicycle' || o.type === 'motorcycle') {
          ctx.fillStyle = o.type === 'motorcycle' ? '#ef4444' : '#1e293b'; 
          ctx.beginPath(); ctx.roundRect(o.x + o.w/2 - 8, o.y + 10, 16, o.h - 20, 8); ctx.fill(); // Bike body
          
          // Rider
          ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(o.x + o.w/2, o.y + o.h/2 + 5, 12, 0, Math.PI*2); ctx.fill(); // Helmet
          ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.roundRect(o.x + o.w/2 - 15, o.y + o.h/2 - 15, 30, 20, 8); ctx.fill(); // Shoulders
          if (o.type === 'motorcycle') {
            ctx.fillStyle = '#facc15'; ctx.beginPath(); ctx.arc(o.x + o.w/2, o.y + o.h/2 + 10, 8, 0, Math.PI*2); ctx.fill(); // Helmet detail
          }
        } else if (o.type === 'pillar') {
          ctx.fillStyle = '#475569'; ctx.fillRect(o.x, o.y, o.w, o.h);
          ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 3; ctx.strokeRect(o.x+4, o.y+4, o.w-8, o.h-8);
        }
        ctx.restore();
      });

      // Draw Bullets
      this.bullets.forEach(b => {
        const color = b.color || 'white';
        ctx.fillStyle = color; ctx.shadowBlur = 15; ctx.shadowColor = color;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(Math.atan2(b.vy || 0, b.vx || 0));
        ctx.beginPath(); ctx.ellipse(0, 0, 12, 5, 0, 0, Math.PI*2); ctx.fill();
        ctx.restore(); ctx.shadowBlur = 0;
      });

      // Draw Player
      ctx.save();
      if (mode === 'shooter') {
        ctx.translate(this.player.x + this.player.w/2, this.player.y + this.player.h/2);
        ctx.scale(this.player.dir, 1);
        
        // Detail: Backpack
        ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.roundRect(-30, -15, 15, 45, 5); ctx.fill();

        // Body (Hero Bean)
        ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.roundRect(-25, -35, 50, 70, 25); ctx.fill();
        
        // Helmet Visor
        ctx.fillStyle = '#0ea5e9'; ctx.beginPath(); ctx.roundRect(0, -28, 22, 25, 8); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.arc(15, -18, 5, 0, Math.PI*2); ctx.fill();

        // Gun - More detailed
        ctx.fillStyle = '#64748b'; ctx.fillRect(15, -12, 40, 18);
        ctx.fillStyle = '#1e293b'; ctx.fillRect(50, -8, 15, 10);
        ctx.fillStyle = '#f97316'; ctx.fillRect(65, -5, 5, 4); // Muzzle tip

        // Legs
        const legWalk = this.player.vx !== 0 ? Math.sin(this.frameCount * 0.4) * 12 : 0;
        ctx.fillStyle = '#0f172a';
        ctx.beginPath(); ctx.roundRect(-12, 25 - legWalk, 10, 25, 6); ctx.fill();
        ctx.beginPath(); ctx.roundRect(6, 25 + legWalk, 10, 25, 6); ctx.fill();
      } else {
        ctx.translate(this.player.x + this.player.w/2, this.player.y + this.player.h/2);
        if (mode === 'racer') {
          ctx.save();
          
          // Visual scaling logic if jumping
          const scaleFactor = this.player.jumping ? 1 + (Math.abs(500 - this.player.y) / 150) : 1;
          ctx.scale(scaleFactor, scaleFactor);
          // Add drop shadow if jumping
          if (this.player.jumping) {
            ctx.shadowBlur = 40;
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowOffsetY = 30;
          }

          // BBRacing Car style - Enlarged & Detailed Back
          ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.roundRect(-40, -60, 80, 120, 15); ctx.fill();
          // Racing Stripes
          ctx.fillStyle = 'white'; ctx.fillRect(-8, -60, 16, 120);
          // Windshield (Light blue reflective)
          ctx.fillStyle = '#7dd3fc'; ctx.beginPath(); ctx.roundRect(-30, -35, 60, 40, 10); ctx.fill();
          
          // Driver (Helmet inside - showing back of white helmet)
          ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(0, -15, 12, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = '#1e293b'; ctx.fillRect(-10, -10, 20, 4); // Helmet strap detail

          // Wide Spoiler
          ctx.fillStyle = '#b91c1c'; ctx.fillRect(-45, 40, 90, 15);
          ctx.fillStyle = '#000'; ctx.fillRect(-42, 45, 84, 5);
          
          // Rear Window
          ctx.fillStyle = '#7dd3fc'; ctx.beginPath(); ctx.roundRect(-28, 35, 56, 18, 5); ctx.fill();
          
          // Glowing Tail Lights
          ctx.fillStyle = '#f43f5e'; ctx.shadowBlur = 15; ctx.shadowColor = 'red';
          ctx.beginPath(); ctx.roundRect(-35, -58, 15, 12, 4); ctx.fill();
          ctx.beginPath(); ctx.roundRect(20, -58, 15, 12, 4); ctx.fill(); ctx.shadowBlur = 0;

          // Exhaust pipes
          ctx.fillStyle = '#475569'; ctx.fillRect(-25, 55, 10, 10); ctx.fillRect(15, 55, 10, 10);
          
          if (this.player.jumping) {
             ctx.fillStyle = '#fbbf24'; ctx.shadowBlur = 20; ctx.shadowColor = '#fbbf24';
             ctx.beginPath(); ctx.arc(-20, 75, 15, 0, Math.PI*2); ctx.fill();
             ctx.beginPath(); ctx.arc(20, 75, 15, 0, Math.PI*2); ctx.fill();
             ctx.shadowBlur = 0;
          }
          
          ctx.restore();
        } else if (mode === 'runner') {
           const bob = Math.sin(this.frameCount * 0.4) * 6;
           // Detailed Back for Runner (Temple Run style)
           // Backpack (Large blue bag)
           ctx.fillStyle = '#1e3a8a'; ctx.beginPath(); ctx.roundRect(-30, -10 + bob, 60, 50, 12); ctx.fill();
           // Straps
           ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-25, -10+bob); ctx.lineTo(-20, -25+bob); ctx.stroke();
           ctx.beginPath(); ctx.moveTo(25, -10+bob); ctx.lineTo(20, -25+bob); ctx.stroke();
           
           // Blue Overalls / Hoodie
           ctx.fillStyle = '#2563eb'; ctx.beginPath(); ctx.roundRect(-25, -25 + bob, 50, 60, 15); ctx.fill();
           
           // Head & Cap (Back view)
           ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(0, -45 + bob, 22, 0, Math.PI*2); ctx.fill();
           // Red Cap rotated back
           ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(0, -52 + bob, 20, Math.PI, Math.PI*2); ctx.fill();
           ctx.fillStyle = '#b91c1c'; ctx.fillRect(-25, -55 + bob, 50, 6); // Brim at the back

           // Legs (Jeans)
           const runCycle = Math.sin(this.frameCount * 0.5) * 15;
           ctx.fillStyle = '#172554';
           ctx.beginPath(); ctx.roundRect(-18, 30 + bob + runCycle, 15, 30, 8); ctx.fill();
           ctx.beginPath(); ctx.roundRect(3, 30 + bob - runCycle, 15, 30, 8); ctx.fill();
           
           // Hoverboard (Subway Surfer style)
           if (this.player.jumping) {
             ctx.fillStyle = '#f43f5e'; ctx.shadowBlur = 20; ctx.shadowColor = '#f43f5e';
             ctx.beginPath(); ctx.roundRect(-45, 50, 90, 15, 8); ctx.fill(); ctx.shadowBlur = 0;
             // Fire thruster
             ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(-30, 65, 8, 0, Math.PI*2); ctx.fill();
             ctx.beginPath(); ctx.arc(30, 65, 8, 0, Math.PI*2); ctx.fill();
           }
        }
      }
      ctx.restore();
    }

    // Countdown Overlay
      if (this.gamePhase() === 'countdown') {
       ctx.fillStyle = 'rgba(0,0,0,0.5)';
       ctx.fillRect(0, 0, w, h);
       
       // Draw a little "Get Ready" character
       ctx.save();
       ctx.translate(w/2, h/2 + 150);
       ctx.fillStyle = '#fbbf24';
       ctx.beginPath(); ctx.roundRect(-30, -40, 60, 80, 20); ctx.fill();
       ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.arc(-10, -10, 4, 0, Math.PI*2); ctx.fill(); ctx.arc(10, -10, 4, 0, Math.PI*2); ctx.fill();
       ctx.restore();

       ctx.fillStyle = 'white';
       ctx.font = 'bold 120px Inter';
       ctx.textAlign = 'center';
       ctx.textBaseline = 'middle';
       ctx.fillText(this.countdown().toString(), w/2, h/2);
       ctx.shadowBlur = 20;
       ctx.shadowColor = 'orange';
       ctx.strokeText(this.countdown().toString(), w/2, h/2);
       ctx.shadowBlur = 0;
    }
  }


  private finishGame() {
    const coinsEarned = Math.floor(this.score() / 10);
    this.coinsEarnedThisGame.set(coinsEarned);

    let earned = 0;
    if (this.score() > 3500) earned = 3;
    else if (this.score() > 2500) earned = 2;
    else if (this.score() > 1500) earned = 1;
    
    this.gemsEarned.set(earned);
    
    // Record attempt and update persistent engine states
    this.igwt.recordAttempt();
    this.igwt.addReward(coinsEarned, earned);
    
    // Explicitly update cumulative coins signal
    this.totalCoinsAccumulated.set(this.igwt.state().coins);
    
    this.view.set('postgame');

    // External Frontend Handshake (Session Terminated)
    if (this.igwt.state().attemptsToday >= 3) {
      setTimeout(() => {
        try {
          interface CustomWindow extends Window {
            igwtShopifyTrigger?: (coins: number, discount: number) => void;
          }
          const w = window as unknown as CustomWindow;
          if (w.igwtShopifyTrigger) {
            w.igwtShopifyTrigger(this.totalCoinsAccumulated(), this.calculateDiscount());
          }
          window.dispatchEvent(new CustomEvent('igwt_session_terminated', { 
            detail: { discount: this.calculateDiscount(), coins: this.totalCoinsAccumulated() } 
          }));
          
          if (typeof window !== 'undefined' && window.parent) {
             window.parent.postMessage({
               type: 'igwt_session_terminated',
               discount: this.calculateDiscount(),
               coins: this.totalCoinsAccumulated()
             }, '*');
             // Also collapse widget
             window.parent.postMessage({ type: 'igwt_collapse' }, '*');
          }
        } catch(e) { console.error('Engine Handshake Error:', e); }
      }, 500);
    }
  }

  goToShowcase() {
    this.view.set('showcase');
  }

  calculateDiscount(): number {
    const coins = this.totalCoinsAccumulated();
    if (coins >= 300) return 0.155; // 15.5% (Absolute Safe Maximum Cap Protection)
    if (coins >= 250) return 0.150; // 15.0%
    if (coins >= 200) return 0.130; // 13.0%
    if (coins >= 150) return 0.100; // 10.0%
    if (coins >= 100) return 0.050; // 5.0%
    if (coins >= 50)  return 0.025; // 2.5%
    return 0.0;
  }

  claimReward(variantId: string) {
    // Inject exact calculated percentage into the Shopify checkout URL via discountCode
    const discountCode = 'IGWT' + Math.round(this.calculateDiscount() * 100);
    const url = this.igwt.getCheckoutPermalink(variantId, discountCode);
    
    // Reset coins to 0 so the game goes back to $0
    this.igwt.resetRewards();

    if (window.location.hostname.includes('run.app') || window.location.hostname.includes('localhost')) {
      this.simulatingCheckoutUrl.set(url);
      setTimeout(() => this.simulatingCheckoutUrl.set(null), 5000);
    } else {
      window.location.href = url;
    }
  }
}
