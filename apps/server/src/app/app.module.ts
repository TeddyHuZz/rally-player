import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { StreamController } from './stream/stream.controller';
import { StreamService } from './stream/stream.service';

@Module({
  imports: [],
  controllers: [AppController, StreamController],
  providers: [AppService, StreamService],
})
export class AppModule {}
