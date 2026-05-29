import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { PlayerComponent } from './player/player.component';

@Component({
  imports: [PlayerComponent, RouterModule],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected title = 'client';
}
