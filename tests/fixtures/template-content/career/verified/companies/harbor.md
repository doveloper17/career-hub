---
id: EXP-HARBOR-001
slug: harbor-data
title: 데이터 수집 작업의 재처리 기능 구현
company: 하버데이터
kind: company
role: 데이터 엔지니어
start: '2020-07-01'
end: '2022-06-30'
status: verified
visibility: public
confirmedBy: 예시 작성자
tags: [Python, PostgreSQL, Airflow]
problem: 데이터 수집 중 일부 작업이 실패하면 전체 수집을 다시 실행해야 했다.
action: 작업별 실행 상태를 기록하고 실패한 작업만 다시 처리하도록 구성했다.
result: 운영 담당자가 실패 구간을 확인하고 해당 작업만 재실행할 수 있게 되었다.
contribution: 실행 상태 기록과 재처리 로직 구현을 담당했다.
statements:
  - 'Python과 PostgreSQL로 데이터 수집 작업의 실행 상태 기록과 재처리 로직을 구현했다.'
  - 'Airflow 작업에서 실패 구간을 확인하고 해당 작업만 재실행할 수 있도록 구성했다.'
---

## 문제

일부 수집 작업이 실패해도 전체 흐름을 처음부터 다시 실행해야 해 원인 확인과 복구가 번거로웠다.

## 수행한 작업

작업 단위로 상태를 기록하고 실패한 구간을 다시 실행하도록 재처리 흐름을 구성했다. 중복 실행 시 처리 결과를 확인하는 절차도 문서화했다.

## 결과와 기여 범위

운영 담당자가 실패 위치와 처리 상태를 확인할 수 있게 되었다. 실행 상태 기록과 재처리 로직을 담당한 사례이며, 정량 성과는 설정하지 않았다.
