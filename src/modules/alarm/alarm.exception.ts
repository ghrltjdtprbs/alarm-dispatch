import { ErrorCode } from '../../common/exception/error-code';
import { BadRequestException, ConflictException, NotFoundException } from '../../common/exception/predefined';
import { AlarmStatus } from './alarm-status.enum';

export class AlarmNotFoundException extends NotFoundException {
  constructor(alarmId: string) {
    super(ErrorCode.ALARM_NOT_FOUND, `알림을 찾을 수 없습니다: ${alarmId}`);
  }
}

// 현재 상태에서 허용되지 않는 전이 요청 (예: 발송 중인 알림 재시작, 완료된 알림 취소)
export class AlarmInvalidStatusException extends ConflictException {
  constructor(current: AlarmStatus, action: string) {
    super(ErrorCode.ALARM_INVALID_STATUS, `${current} 상태의 알림은 ${action}할 수 없습니다.`);
  }
}

export class AlarmRecipientsInvalidException extends BadRequestException {
  constructor(reason: string) {
    super(ErrorCode.ALARM_RECIPIENTS_INVALID, reason);
  }
}
