import test from "node:test";
import assert from "node:assert/strict";
import {
  nonemptyUserId,
  managerIdFromVoxRow,
  shouldCountExtraCallActivity,
} from "./load-bitrix.mjs";

test("пустой PORTAL_USER_ID не считается сотрудником", () => {
  assert.equal(nonemptyUserId(""), "");
  assert.equal(nonemptyUserId("0"), "");
  assert.equal(nonemptyUserId(0), "");
  assert.equal(nonemptyUserId(null), "");
  assert.equal(nonemptyUserId("42"), "42");
});

test("звонок телефонии без сотрудника берёт ответственного дела CRM", () => {
  const activities = new Map([
    ["9001", { ID: "9001", RESPONSIBLE_ID: "77", TYPE_ID: 2, COMPLETED: "Y" }],
  ]);
  assert.equal(
    managerIdFromVoxRow({ PORTAL_USER_ID: "0", CRM_ACTIVITY_ID: "9001" }, activities),
    "77"
  );
  assert.equal(
    managerIdFromVoxRow({ PORTAL_USER_ID: "15", CRM_ACTIVITY_ID: "9001" }, activities),
    "15"
  );
  assert.equal(managerIdFromVoxRow({ PORTAL_USER_ID: "", CRM_ACTIVITY_ID: "0" }, activities), "0");
});

test("дело-звонок не дублирует статистику телефонии и пропускает незавершённые", () => {
  const voxIds = new Set(["9001"]);
  assert.equal(
    shouldCountExtraCallActivity({ ID: "9001", TYPE_ID: 2, COMPLETED: "Y" }, voxIds),
    false
  );
  assert.equal(
    shouldCountExtraCallActivity({ ID: "9002", TYPE_ID: 2, COMPLETED: "Y" }, voxIds),
    true
  );
  assert.equal(
    shouldCountExtraCallActivity({ ID: "9003", TYPE_ID: 2, COMPLETED: "N" }, voxIds),
    false
  );
  assert.equal(
    shouldCountExtraCallActivity({ ID: "9004", TYPE_ID: 1, COMPLETED: "Y" }, voxIds),
    false
  );
});
