import { Component, HostListener, OnDestroy, NgZone, ChangeDetectorRef, OnInit } from '@angular/core';
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

  private ytPlayer: any = null;

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.loadBadmintonFeed();
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
    this.cdr.detectChanges();

    let feedUrl = `http://localhost:3000/api/stream/badminton-feed?page=${page}`;
    if (searchQuery) {
      feedUrl += `&query=${encodeURIComponent(searchQuery.trim())}`;
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
          this.cdr.detectChanges();
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
          this.cdr.detectChanges();
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
    this.cdr.detectChanges();

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
              this.cdr.detectChanges();
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
              this.cdr.detectChanges();
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
  }

  setSpeed(speed: number) {
    this.currentSpeed = speed;
    if (this.ytPlayer) {
      try {
        this.ytPlayer.setPlaybackRate(speed);
      } catch (err) {
        console.warn('Error in setSpeed:', err);
      }
    }
  }

  seek(seconds: number) {
    if (!this.ytPlayer) return;
    try {
      const currentTime = this.ytPlayer.getCurrentTime();
      this.ytPlayer.seekTo(Math.max(0, currentTime + seconds), true);
    } catch (err) {
      console.warn('Error in seek:', err);
    }
  }

  stepFrame(direction: number) {
    this.seek(direction * 0.5);
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

  ngOnDestroy() {
    this.destroyPlayer();
  }
}
