import { Controller, Get, Query, Logger } from '@nestjs/common';
import { StreamService } from './stream.service';

@Controller('stream')
export class StreamController {
  private readonly logger = new Logger(StreamController.name);

  constructor(private readonly streamService: StreamService) {}

  @Get('badminton-feed')
  async getBadmintonFeed(
    @Query('query') query?: string,
    @Query('page') page?: string
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    return this.streamService.getBadmintonFeed(query, pageNum);
  }
}
