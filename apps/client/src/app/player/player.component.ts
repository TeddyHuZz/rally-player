import { Component, HostListener, OnDestroy, NgZone, ChangeDetectorRef, OnInit, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

let youtubeApiLoadedPromise: Promise<void> | null = null;

function loadYouTubeIframeAPI(): Promise<void> {
  if (youtubeApiLoadedPromise) {
    return youtubeApiLoadedPromise;
  }

  youtubeApiLoadedPromise = new Promise<void>((resolve) => {
    const win = window as any;
    if (win.YT && win.YT.Player) {
      resolve();
      return;
    }

    const previousCallback = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      if (previousCallback) previousCallback();
      resolve();
    };

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
  });

  return youtubeApiLoadedPromise;
}

@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './player.component.html',
  styleUrl: './player.component.css',
})
export class PlayerComponent implements OnInit, OnDestroy {
  rawUrl = '';
  streamSourceUrl: string | null = null; // Store the active YouTube Video ID here
  isPlaying = false;
  currentSpeed = 1;
  availableSpeeds = [0.25, 0.5, 0.75, 1];
  curatedVideos: any[] = [];
  isFeedLoading = false;
  currentQuery = '';
  currentPage = 1;
  isLoadingMore = false;
  hasMoreVideos = true;
  activeTab: 'videos' | 'live' | 'tournaments' | 'rankings' = 'videos';

  // Tournament dashboard states
  tournaments: any[] = [];
  selectedTournament: any = null;
  activeTournamentSubTab: 'ongoing' | 'upcoming' | 'past' = 'ongoing';
  isTournamentsLoading = false;
  searchingMatchId: string | null = null;
  showVpnHelper = true;
  streamProxyRegion: 'DIRECT' | 'DE' | 'NL' | 'US' = 'DIRECT';

  // Rankings states
  rankingsList: any[] = [];
  selectedRankingDiscipline = "Men's Singles";
  isRankingsLoading = false;
  selectedPlayerProfile: any = null;

  @ViewChild('nativeVideoPlayer') nativeVideoPlayerRef!: ElementRef<HTMLVideoElement>;

  private ytPlayer: any = null;
  private liveScoreInterval: any = null;

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.loadBadmintonFeed();
  }

  switchTab(tab: 'videos' | 'live' | 'tournaments' | 'rankings') {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.rawUrl = '';
    this.currentQuery = '';
    this.destroyPlayer();
    this.streamSourceUrl = null;
    
    if (tab === 'videos' || tab === 'live') {
      this.loadBadmintonFeed();
    } else if (tab === 'tournaments') {
      this.loadTournaments();
    } else if (tab === 'rankings') {
      this.loadRankings();
    }
  }

  loadBadmintonFeed(searchQuery?: string, page = 1) {
    if (page === 1) {
      this.isFeedLoading = true;
      this.curatedVideos = [];
      this.currentPage = 1;
      this.hasMoreVideos = true;
    } else {
      this.isLoadingMore = true;
    }
    this.cdr.markForCheck();

    // Determine the query term for the backend feed
    let queryParam = searchQuery;
    if (!queryParam) {
      if (this.activeTab === 'live') {
        queryParam = '__live_tournaments__';
      }
    } else {
      if (this.activeTab === 'live') {
        queryParam = `${queryParam.trim()} live`;
      }
    }

    let feedUrl = `http://localhost:3000/api/stream/badminton-feed?page=${page}`;
    if (queryParam) {
      feedUrl += `&query=${encodeURIComponent(queryParam.trim())}`;
    }

    fetch(feedUrl)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load feed.');
        return res.json();
      })
      .then((data: any[]) => {
        this.zone.run(() => {
          const list = Array.isArray(data) ? data : [];
          if (page === 1) {
            this.curatedVideos = list;
            this.isFeedLoading = false;
          } else {
            this.curatedVideos = [...this.curatedVideos, ...list];
            this.isLoadingMore = false;
          }

          this.currentPage = page;
          this.hasMoreVideos = list.length >= 12;
          this.cdr.markForCheck();
        });
      })
      .catch(err => {
        console.error('Failed to load badminton feed:', err);
        this.zone.run(() => {
          if (page === 1) {
            this.curatedVideos = [];
            this.isFeedLoading = false;
          } else {
            this.isLoadingMore = false;
          }
          this.hasMoreVideos = false;
          this.cdr.markForCheck();
        });
      });
  }

  loadMore() {
    if (this.isFeedLoading || this.isLoadingMore || !this.hasMoreVideos) return;
    this.loadBadmintonFeed(this.currentQuery, this.currentPage + 1);
  }

  extractYouTubeVideoId(url: string): string | null {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  }

  getHighResThumbnail(video: any): string {
    const videoId = this.extractYouTubeVideoId(video.url);
    if (videoId) {
      return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    }
    return video.thumbnail;
  }

  handleThumbnailError(event: any, video: any) {
    const img = event.target;
    if (img && video) {
      const videoId = this.extractYouTubeVideoId(video.url);
      if (videoId) {
        const fallbackUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        if (img.src !== fallbackUrl) {
          img.src = fallbackUrl;
          return;
        }
      }
      if (img.src !== video.thumbnail) {
        img.src = video.thumbnail;
      }
    }
  }

  closeVideoPlayer() {
    this.destroyPlayer();
    this.streamSourceUrl = null;
    this.rawUrl = '';
    this.cdr.markForCheck();
  }

  loadStream() {
    const videoId = this.extractYouTubeVideoId(this.rawUrl.trim());
    if (!videoId) {
      console.warn('Invalid YouTube URL:', this.rawUrl);
      return;
    }

    // Smoothly scroll to the top of the page to focus on the video workspace
    window.scrollTo({ top: 0, behavior: 'smooth' });

    this.streamSourceUrl = videoId;
    this.isPlaying = false;
    this.currentSpeed = 1;
    this.destroyPlayer();
    this.cdr.markForCheck();

    if (this.streamProxyRegion === 'DIRECT') {
      loadYouTubeIframeAPI()
        .then(() => {
          this.zone.run(() => {
            setTimeout(() => {
              this.initYouTubePlayer(videoId);
            }, 50);
          });
        })
        .catch(err => {
          console.error('Failed to load YouTube API:', err);
        });
    } else {
      // For native HTML5 video player, we don't need YouTube API.
      this.zone.run(() => {
        setTimeout(() => {
          const video = this.nativeVideoPlayerRef?.nativeElement;
          if (video) {
            video.playbackRate = this.currentSpeed;
          }
          this.cdr.markForCheck();
        }, 100);
      });
    }
  }

  private initYouTubePlayer(videoId: string) {
    if (this.ytPlayer) {
      this.destroyPlayer();
    }

    this.zone.runOutsideAngular(() => {
      this.ytPlayer = new (window as any).YT.Player('yt-player-container', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          fs: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            this.zone.run(() => {
              if (this.currentSpeed !== 1) {
                this.ytPlayer.setPlaybackRate(this.currentSpeed);
              }
              this.cdr.markForCheck();
            });
          },
          onStateChange: (event: any) => {
            this.zone.run(() => {
              const state = event.data;
              if (state === 1) {
                this.isPlaying = true;
              } else if (state === 2 || state === 0) {
                this.isPlaying = false;
              }
              this.cdr.markForCheck();
            });
          }
        }
      });
    });
  }

  private destroyPlayer() {
    if (this.ytPlayer) {
      try {
        this.ytPlayer.destroy();
      } catch (err) {
        // Safe check
      }
      this.ytPlayer = null;
    }
    this.isPlaying = false;
  }

  isSearchUrl(url: string): boolean {
    const val = url.trim();
    return val.startsWith('http://') || val.startsWith('https://') || val.includes('youtube.com') || val.includes('youtu.be');
  }

  onSearchOrStream() {
    const query = this.rawUrl.trim();
    if (!query) return;

    if (this.isSearchUrl(query)) {
      this.loadStream();
    } else {
      this.currentQuery = query;
      this.loadBadmintonFeed(query);
    }
  }

  clearSearch() {
    this.rawUrl = '';
    this.currentQuery = '';
    this.loadBadmintonFeed();
  }

  selectCuratedVideo(video: { title: string; url: string }) {
    this.rawUrl = video.url;
    this.loadStream();
  }

  togglePlay() {
    if (this.streamProxyRegion === 'DIRECT') {
      if (!this.ytPlayer) return;
      try {
        const state = this.ytPlayer.getPlayerState();
        if (state === 1) {
          this.ytPlayer.pauseVideo();
        } else {
          this.ytPlayer.playVideo();
        }
      } catch (err) {
        console.warn('Error in togglePlay:', err);
      }
    } else {
      const video = this.nativeVideoPlayerRef?.nativeElement;
      if (video) {
        if (video.paused) {
          video.play().catch(err => console.warn('Error playing video:', err));
        } else {
          video.pause();
        }
      }
    }
  }

  setSpeed(speed: number) {
    this.currentSpeed = speed;
    if (this.streamProxyRegion === 'DIRECT') {
      if (this.ytPlayer) {
        try {
          this.ytPlayer.setPlaybackRate(speed);
        } catch (err) {
          console.warn('Error in setSpeed:', err);
        }
      }
    } else {
      const video = this.nativeVideoPlayerRef?.nativeElement;
      if (video) {
        video.playbackRate = speed;
      }
    }
  }

  seek(seconds: number) {
    if (this.streamProxyRegion === 'DIRECT') {
      if (!this.ytPlayer) return;
      try {
        const currentTime = this.ytPlayer.getCurrentTime();
        this.ytPlayer.seekTo(Math.max(0, currentTime + seconds), true);
      } catch (err) {
        console.warn('Error in seek:', err);
      }
    } else {
      const video = this.nativeVideoPlayerRef?.nativeElement;
      if (video) {
        video.currentTime = Math.max(0, video.currentTime + seconds);
      }
    }
  }

  stepFrame(direction: number) {
    this.seek(direction * 0.5);
  }

  onRegionChange() {
    if (this.streamSourceUrl) {
      this.loadStream();
    }
  }

  getProxyStreamUrl(videoId: string): string {
    return `http://localhost:3000/api/stream/proxy-stream?videoId=${videoId}&country=${this.streamProxyRegion}`;
  }

  onNativePlay() {
    this.isPlaying = true;
    this.cdr.markForCheck();
  }

  onNativePause() {
    this.isPlaying = false;
    this.cdr.markForCheck();
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcuts(event: KeyboardEvent) {
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }

    if (!this.streamSourceUrl) return;

    switch (event.key.toLowerCase()) {
      case ' ':
        event.preventDefault();
        this.togglePlay();
        break;
      case 'd':
        event.preventDefault();
        this.stepFrame(1);
        break;
      case 'a':
        event.preventDefault();
        this.stepFrame(-1);
        break;
      case 'arrowright':
        event.preventDefault();
        this.seek(5);
        break;
      case 'arrowleft':
        event.preventDefault();
        this.seek(-5);
        break;
    }
  }

  loadTournaments(forceRefresh = false) {
    if (!forceRefresh && this.tournaments.length > 0) {
      this.autoSelectTournament();
      this.startLiveScoreSimulation();
      this.cdr.markForCheck();
      return;
    }

    this.isTournamentsLoading = true;
    this.tournaments = [];
    this.selectedTournament = null;
    this.cdr.markForCheck();

    fetch('http://localhost:3000/api/stream/tournaments')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load tournaments.');
        return res.json();
      })
      .then((data: any[]) => {
        this.zone.run(() => {
          this.tournaments = Array.isArray(data) ? data : [];
          this.isTournamentsLoading = false;
          this.autoSelectTournament();
          this.startLiveScoreSimulation();
          this.cdr.markForCheck();
        });
      })
      .catch(err => {
        console.error('Failed to load tournaments:', err);
        this.zone.run(() => {
          this.tournaments = [];
          this.isTournamentsLoading = false;
          this.cdr.markForCheck();
        });
      });
  }

  loadRankings(forceRefresh = false) {
    if (!forceRefresh && this.rankingsList.length > 0) {
      this.autoSelectPlayer();
      this.cdr.markForCheck();
      return;
    }

    this.isRankingsLoading = true;
    this.rankingsList = [];
    this.selectedPlayerProfile = null;
    this.cdr.markForCheck();

    const url = `http://localhost:3000/api/stream/rankings${forceRefresh ? '?force=true' : ''}`;
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load rankings.');
        return res.json();
      })
      .then((data: any[]) => {
        this.zone.run(() => {
          this.rankingsList = Array.isArray(data) ? data : [];
          this.isRankingsLoading = false;
          this.autoSelectPlayer();
          this.cdr.markForCheck();
        });
      })
      .catch(err => {
        console.error('Failed to load rankings:', err);
        this.zone.run(() => {
          this.rankingsList = [];
          this.isRankingsLoading = false;
          this.selectedPlayerProfile = null;
          this.cdr.markForCheck();
        });
      });
  }

  selectRankingDiscipline(discipline: string) {
    this.selectedRankingDiscipline = discipline;
    this.autoSelectPlayer();
    this.cdr.markForCheck();
  }

  getSelectedRanking() {
    return this.rankingsList.find(r => r.discipline === this.selectedRankingDiscipline);
  }

  playerImages: string[] = [];
  isImageLoading = false;

  autoSelectPlayer() {
    const activeRanking = this.getSelectedRanking();
    if (activeRanking && activeRanking.rankings && activeRanking.rankings.length > 0) {
      this.selectPlayer(activeRanking.rankings[0]);
    } else {
      this.selectPlayer(null);
    }
  }

  selectPlayer(player: any) {
    this.selectedPlayerProfile = player;
    this.playerImages = [];
    this.cdr.markForCheck();

    if (player && player.slugs && player.slugs.length > 0) {
      this.loadPlayerImages(player.slugs);
    }
  }

  loadPlayerImages(slugs: string[]) {
    this.isImageLoading = true;
    this.playerImages = [];
    this.cdr.markForCheck();

    const promises = slugs.map(slug => 
      fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`)
        .then(res => {
          if (!res.ok) throw new Error();
          return res.json();
        })
        .then(data => data.thumbnail?.source || null)
        .catch(() => null)
    );

    Promise.all(promises).then(images => {
      this.zone.run(() => {
        this.playerImages = images.filter(img => img !== null) as string[];
        this.isImageLoading = false;
        this.cdr.markForCheck();
      });
    });
  }

  searchPlayerVideos(playerName: string) {
    if (!playerName) return;
    const cleanName = playerName.split(/[\/&]/)[0].trim();
    
    this.activeTab = 'videos';
    this.rawUrl = cleanName;
    this.currentQuery = cleanName;
    this.loadBadmintonFeed(cleanName);
    
    // Smooth scroll to curated section
    setTimeout(() => {
      const el = document.querySelector('.curated-section');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  searchPlayerLive(playerName: string) {
    if (!playerName) return;
    const cleanName = playerName.split(/[\/&]/)[0].trim();
    
    this.activeTab = 'live';
    this.rawUrl = `${cleanName} live`;
    this.currentQuery = `${cleanName} live`;
    this.loadBadmintonFeed(`${cleanName} live`);
    
    setTimeout(() => {
      const el = document.querySelector('.curated-section');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  getCountryFlag(country: string): string {
    if (!country) return '🏳️';
    const cleanCountry = country.toLowerCase().trim();
    if (cleanCountry.includes('china')) return '🇨🇳';
    if (cleanCountry.includes('korea')) return '🇰🇷';
    if (cleanCountry.includes('japan')) return '🇯🇵';
    if (cleanCountry.includes('denmark')) return '🇩🇰';
    if (cleanCountry.includes('indonesia')) return '🇮🇩';
    if (cleanCountry.includes('malaysia')) return '🇲🇾';
    if (cleanCountry.includes('chinese taipei') || cleanCountry.includes('taiwan') || cleanCountry.includes('taipei')) return '🇹🇼';
    if (cleanCountry.includes('thailand')) return '🇹🇭';
    if (cleanCountry.includes('india')) return '🇮🇳';
    if (cleanCountry.includes('france')) return '🇫🇷';
    if (cleanCountry.includes('england')) return '🇬🇧';
    if (cleanCountry.includes('hong kong')) return '🇭🇰';
    if (cleanCountry.includes('singapore')) return '🇸🇬';
    if (cleanCountry.includes('canada')) return '🇨🇦';
    if (cleanCountry.includes('spain')) return '🇪🇸';
    if (cleanCountry.includes('united states') || cleanCountry.includes('usa')) return '🇺🇸';
    if (cleanCountry.includes('bulgaria')) return '🇧🇬';
    if (cleanCountry.includes('germany')) return '🇩🇪';
    if (cleanCountry.includes('netherlands')) return '🇳🇱';
    
    if (cleanCountry.includes('/') || cleanCountry.includes('&') || cleanCountry.includes('and')) {
      const parts = cleanCountry.split(/[\/&]|and/);
      return parts.map(p => this.getCountryFlag(p)).join(' ');
    }
    
    return '🏳️';
  }

  getPlayerInitials(name: string): string {
    if (!name) return '?';
    
    if (name.includes('/')) {
      const partners = name.split('/');
      const init1 = this.getSinglePlayerInitials(partners[0]);
      const init2 = this.getSinglePlayerInitials(partners[1]);
      return `${init1}/${init2}`;
    }
    
    return this.getSinglePlayerInitials(name);
  }

  private getSinglePlayerInitials(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    
    const first = parts[0].charAt(0).toUpperCase();
    const last = parts[parts.length - 1].charAt(0).toUpperCase();
    return `${first}${last}`;
  }

  trackByRank(index: number, item: any): number {
    return item.rank;
  }

  trackByDiscipline(index: number, item: string): string {
    return item;
  }

  switchTournamentSubTab(subTab: 'ongoing' | 'upcoming' | 'past') {
    if (this.activeTournamentSubTab === subTab) return;
    this.activeTournamentSubTab = subTab;
    this.autoSelectTournament();
    this.cdr.markForCheck();
  }

  autoSelectTournament() {
    const filtered = this.getFilteredTournaments(this.activeTournamentSubTab);
    if (filtered.length > 0) {
      this.selectedTournament = filtered[0];
    } else {
      this.selectedTournament = null;
    }
  }

  selectTournament(t: any) {
    this.selectedTournament = t;
    this.cdr.markForCheck();
  }

  playTournamentVideo(match: any, tournamentName: string) {
    if (!match) return;
    
    const isLive = !!match.isLive;
    const staticId = match.videoId;

    // Smoothly scroll to the top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Switch tab so player container is mounted
    this.activeTab = isLive ? 'live' : 'videos';

    if (isLive && staticId) {
      this.rawUrl = `https://www.youtube.com/watch?v=${staticId}`;
      this.loadStream();
      return;
    }
    
    // Unique identifier for the search spinner state
    const matchKey = `${match.player1 || match.player || ''}-${match.player2 || match.opponent || ''}`;
    this.searchingMatchId = matchKey;
    this.cdr.markForCheck();

    // Resolve the video ID dynamically from YouTube search
    const player1Name = match.player1 || match.player || '';
    const player2Name = match.player2 || match.opponent || '';
    
    const queryParams = `tournament=${encodeURIComponent(tournamentName)}` +
                        `&discipline=${encodeURIComponent(match.discipline)}` +
                        `&player1=${encodeURIComponent(player1Name)}` +
                        `&player2=${encodeURIComponent(player2Name)}` +
                        `&isLive=${isLive}`;
    
    fetch(`http://localhost:3000/api/stream/find-match-video?${queryParams}`)
      .then(res => {
        if (!res.ok) throw new Error('API failed');
        return res.json();
})
      .then((data: { videoId: string | null }) => {
        this.zone.run(() => {
          this.searchingMatchId = null;
          const resolvedId = data.videoId || staticId;
          
          if (!resolvedId) {
            console.warn('Could not resolve match video ID');
            this.activeTab = 'tournaments';
            alert('No video highlights found on YouTube for this match.');
            this.cdr.markForCheck();
            return;
          }

          this.rawUrl = `https://www.youtube.com/watch?v=${resolvedId}`;
          this.loadStream();
          this.cdr.markForCheck();
        });
      })
      .catch(err => {
        console.error('Error finding match video:', err);
        this.zone.run(() => {
          this.searchingMatchId = null;
          
          // Fall back to static ID if available
          if (staticId) {
            this.rawUrl = `https://www.youtube.com/watch?v=${staticId}`;
            this.loadStream();
          } else {
            this.activeTab = 'tournaments';
            alert('Could not search for match video at this time.');
          }
          this.cdr.markForCheck();
        });
      });
  }

  getFilteredTournaments(status: string): any[] {
    return this.tournaments.filter(t => t.status === status);
  }

  parseScore(scoreStr: string): { p1: string; p2: string }[] {
    if (!scoreStr) return [];
    return scoreStr.split(',').map(s => {
      const parts = s.trim().split('-');
      return {
        p1: parts[0] || '',
        p2: parts[1] || ''
      };
    });
  }

  getDisciplineAbbr(discipline: string): string {
    if (!discipline) return '';
    const val = discipline.toLowerCase();
    if (val.includes('men\'s singles') || val === 'ms') return 'MS';
    if (val.includes('women\'s singles') || val === 'ws') return 'WS';
    if (val.includes('men\'s doubles') || val === 'md') return 'MD';
    if (val.includes('women\'s doubles') || val === 'wd') return 'WD';
    if (val.includes('mixed doubles') || val === 'xd') return 'XD';
    return discipline.substring(0, 2).toUpperCase();
  }

  private startLiveScoreSimulation() {
    if (this.liveScoreInterval) {
      clearInterval(this.liveScoreInterval);
    }
    
    this.updateLiveScores();

    this.liveScoreInterval = setInterval(() => {
      this.zone.run(() => {
        this.updateLiveScores();
      });
    }, 8000);
  }

  private updateLiveScores() {
    let updatedAny = false;
    for (const t of this.tournaments) {
      if (t.status !== 'ongoing' || !t.details || !t.details.rounds) continue;
      for (const r of t.details.rounds) {
        if (!r.matches) continue;
        for (const match of r.matches) {
          if (!match.isLive) continue;
          
          this.initializeLiveMatchScore(match);
          this.incrementLiveMatchScore(match);
          updatedAny = true;
        }
      }
    }
    if (updatedAny) {
      this.cdr.markForCheck();
    }
  }

  private generateRandomSetScore(): string {
    const winnerScore = 21;
    const loserScore = Math.floor(Math.random() * 10) + 10;
    return Math.random() > 0.5 ? `${winnerScore}-${loserScore}` : `${loserScore}-${winnerScore}`;
  }

  private initializeLiveMatchScore(match: any) {
    if (match.score && match.score !== 'Live') {
      return;
    }

    const rand = Math.random();
    if (rand < 0.25) {
      const s1 = Math.floor(Math.random() * 15);
      const s2 = Math.floor(Math.random() * 15);
      match.score = `${s1}-${s2}`;
    } else if (rand < 0.85) {
      const firstSet = this.generateRandomSetScore();
      const s1 = Math.floor(Math.random() * 15);
      const s2 = Math.floor(Math.random() * 15);
      match.score = `${firstSet}, ${s1}-${s2}`;
    } else {
      const firstSet = this.generateRandomSetScore();
      const secondSet = this.generateRandomSetScore();
      const s1 = Math.floor(Math.random() * 10);
      const s2 = Math.floor(Math.random() * 10);
      match.score = `${firstSet}, ${secondSet}, ${s1}-${s2}`;
    }
  }

  private incrementLiveMatchScore(match: any) {
    if (!match.score) return;
    const sets = match.score.split(',').map((s: string) => s.trim());
    if (sets.length === 0) return;

    const lastSet = sets[sets.length - 1];
    const parts = lastSet.split('-');
    let p1 = parseInt(parts[0], 10) || 0;
    let p2 = parseInt(parts[1], 10) || 0;

    const isSetFinished = (s1: number, s2: number) => {
      if (s1 >= 21 || s2 >= 21) {
        if (Math.abs(s1 - s2) >= 2 || s1 === 30 || s2 === 30) {
          return true;
        }
      }
      return false;
    };

    if (isSetFinished(p1, p2)) {
      let p1SetsWon = 0;
      let p2SetsWon = 0;
      for (const s of sets) {
        const sp = s.split('-');
        const s1 = parseInt(sp[0], 10) || 0;
        const s2 = parseInt(sp[1], 10) || 0;
        if (s1 > s2) p1SetsWon++;
        else if (s2 > s1) p2SetsWon++;
      }

      if (p1SetsWon >= 2 || p2SetsWon >= 2) {
        match.isLive = false;
        match.winner = p1SetsWon >= 2 ? match.player1 : match.player2;
        return;
      }

      p1 = 0;
      p2 = 0;
      sets.push('0-0');
    }

    if (Math.random() > 0.5) {
      p1++;
    } else {
      p2++;
    }

    sets[sets.length - 1] = `${p1}-${p2}`;
    match.score = sets.join(', ');

    let p1SetsWon = 0;
    let p2SetsWon = 0;
    for (const s of sets) {
      const sp = s.split('-');
      const s1 = parseInt(sp[0], 10) || 0;
      const s2 = parseInt(sp[1], 10) || 0;
      if (isSetFinished(s1, s2)) {
        if (s1 > s2) p1SetsWon++;
        else if (s2 > s1) p2SetsWon++;
      }
    }

    if (p1SetsWon >= 2 || p2SetsWon >= 2) {
      match.isLive = false;
      match.winner = p1SetsWon >= 2 ? match.player1 : match.player2;
    }
  }

  ngOnDestroy() {
    this.destroyPlayer();
    if (this.liveScoreInterval) {
      clearInterval(this.liveScoreInterval);
    }
  }
}
