---
id: EXP-MORROW-001
slug: morrow-api
title: 주문 조회 API 성능 개선
company: 모로우랩
kind: company
role: 백엔드 개발자
start: '2024-03-01'
end: '2025-02-28'
status: verified
visibility: public
confirmedBy: 예시 작성자
tags: [Kotlin, Spring Boot, MySQL]
problem: 주문 데이터 증가로 조회 응답이 느려졌다.
action: 실행 계획을 분석하고 인덱스와 조회 쿼리를 수정했다.
result: 테스트 환경에서 평균 응답시간이 800ms에서 250ms로 감소했다.
contribution: 쿼리 분석과 개선 구현을 담당했다.
statements:
  - 'Kotlin, Spring Boot, MySQL 기반 주문 조회 API의 쿼리 분석과 개선 구현을 담당했다.'
  - '테스트 환경에서 주문 조회 API 평균 응답시간을 800ms에서 250ms로 줄였다.'
---

## 문제

주문 데이터 증가에 따라 목록 조회의 대기 시간이 길어졌다. 느린 쿼리 로그와 실행 계획을 확인하여 병목 구간을 좁혔다.

## 수행한 작업

복합 인덱스와 조회 조건을 조정하고 동일한 데이터셋으로 전후 성능을 비교했다.

## 회고

측정 환경과 조건을 함께 남기는 것이 결과 수치만 기록하는 것보다 중요했다.
