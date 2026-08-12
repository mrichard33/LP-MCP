# Five9 Admin API v13 — Phase F WSDL extracts (bulk list deletion)

Verbatim `xs:complexType` / `xs:simpleType` definitions backing
`five9_async_delete_records_from_list`, quoted from the live schema.

**Source:** `https://api.five9.com/wsadmin/v13/AdminWebService?wsdl&user=x`
**Fetched:** 2026-08-12 — HTTP 200, 961,700 bytes.
**Method:** the DOTALL-regex extraction documented in the Phase D FETCH NOTE
(`src/five9/admin-writes.js`). Read-response order was NOT used to derive any
of this.

This file exists for the same reason the Phase C/D/E comment blocks do: it
records how the schema was verified, so the next person extending this surface
does not re-derive it or guess. Do not edit it by hand — re-extract instead.

## Two corrections worth carrying forward

1. **The document is no longer on a single line.** The Phase D FETCH NOTE says
   "~962KB on a SINGLE line". The size still matches (961,700 bytes) but it now
   arrives as **20,206 lines**. The DOTALL-regex instruction remains correct and
   still necessary — a line-oriented grep will half-work, which is worse than
   failing outright.

2. **`stringArray` carries `final="#all"`.** It is exactly the class of type a
   regex anchored on `<xs:complexType name="X">` silently misses, and a no-match
   is indistinguishable from a truncated fetch. The flexible
   `<xs:complexType[^>]*\bname="X"` pattern catches it. Use that one.

## The divergence that matters

The sync and async delete ops share their first two children exactly
(`listName`, `listDeleteSettings`) and differ only in the third:

| Op | Third child | Type | Serializes as |
|---|---|---|---|
| `deleteRecordFromList` (sync) | `record` | `tns:recordData` | repeated `<fields>` |
| `asyncDeleteRecordsFromList` (async) | `importData` | `tns:importData` | repeated `<values>` (`ns1:stringArray`) → repeated `<item>` |

So the `admin-writes.js` header rule "list record bodies emit `<fields>`, not
`<values>`" is a statement about `tns:recordData` and holds for the sync ops it
was written for. It does not transfer to the async family. The async `<values>`
is also **not** list-dispatch's `<values>` (that one matches the report-row
type). The governing rule is unchanged and settles it: new code follows the WSDL.


## Request / response wrappers

```xml
<xs:complexType name="asyncDeleteRecordsFromList">
    <xs:sequence>
      <xs:element minOccurs="0" name="listName" type="xs:string"/>
      <xs:element minOccurs="0" name="listDeleteSettings" type="tns:listDeleteSettings"/>
      <xs:element minOccurs="0" name="importData" type="tns:importData"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="asyncDeleteRecordsFromListResponse">
    <xs:sequence>
      <xs:element minOccurs="0" name="return" type="tns:importIdentifier"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="importIdentifier">
    <xs:sequence>
      <xs:element minOccurs="0" name="identifier" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```


## Settings — listDeleteSettings and its base (inheritance order is load-bearing)

```xml
<xs:complexType name="listDeleteSettings">
    <xs:complexContent>
      <xs:extension base="tns:basicImportSettings">
        <xs:sequence>
          <xs:element minOccurs="0" name="listDeleteMode" type="tns:listDeleteMode"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
```

```xml
<xs:complexType name="basicImportSettings">
    <xs:sequence>
      <xs:element minOccurs="0" name="allowDataCleanup" type="xs:boolean"/>
      <xs:element minOccurs="0" name="callbackAuthProfileName" type="xs:string"/>
      <xs:element minOccurs="0" name="callbackFormat" type="tns:callbackFormat"/>
      <xs:element minOccurs="0" name="callbackUrl" type="xs:string"/>
      <xs:element minOccurs="0" name="countryCode" type="xs:string"/>
      <xs:element minOccurs="0" name="failOnFieldParseError" type="xs:boolean"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="fieldsMapping" nillable="true" type="tns:fieldEntry"/>
      <xs:element minOccurs="0" name="reportEmail" type="xs:string"/>
      <xs:element minOccurs="0" name="separator" type="xs:string"/>
      <xs:element name="skipHeaderLine" type="xs:boolean"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:simpleType name="listDeleteMode">
    <xs:restriction base="xs:string">
      <xs:enumeration value="DELETE_ALL"/>
      <xs:enumeration value="DELETE_IF_SOLE_CRM_MATCH"/>
      <xs:enumeration value="DELETE_EXCEPT_FIRST"/>
    </xs:restriction>
  </xs:simpleType>
```

```xml
<xs:complexType name="fieldEntry">
    <xs:sequence>
      <xs:element name="columnNumber" type="xs:int"/>
      <xs:element minOccurs="0" name="fieldName" type="xs:string"/>
      <xs:element name="key" type="xs:boolean"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:simpleType name="callbackFormat">
    <xs:restriction base="xs:string">
      <xs:enumeration value="XML"/>
      <xs:enumeration value="JSON"/>
    </xs:restriction>
  </xs:simpleType>
```


## Record payload — importData, NOT recordData

```xml
<xs:complexType name="importData">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="values" nillable="true" type="ns1:stringArray"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType final="#all" name="stringArray">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="item" nillable="true" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="recordData">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="fields" nillable="true" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="deleteRecordFromList">
    <xs:sequence>
      <xs:element minOccurs="0" name="listName" type="xs:string"/>
      <xs:element minOccurs="0" name="listDeleteSettings" type="tns:listDeleteSettings"/>
      <xs:element minOccurs="0" name="record" type="tns:recordData"/>
    </xs:sequence>
  </xs:complexType>
```


## Job status / result ops

```xml
<xs:complexType name="isImportRunning">
    <xs:sequence>
      <xs:element minOccurs="0" name="identifier" type="tns:importIdentifier"/>
      <xs:element minOccurs="0" name="waitTime" type="xs:long"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="isImportRunningResponse">
    <xs:sequence>
      <xs:element name="return" type="xs:boolean"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="getListImportResult">
    <xs:sequence>
      <xs:element minOccurs="0" name="identifier" type="tns:importIdentifier"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="getListImportResultResponse">
    <xs:sequence>
      <xs:element minOccurs="0" name="return" type="tns:listImportResult"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="listImportResult">
    <xs:complexContent>
      <xs:extension base="tns:basicImportResult">
        <xs:sequence>
          <xs:element name="callNowQueued" type="xs:long"/>
          <xs:element name="crmRecordsInserted" type="xs:long"/>
          <xs:element name="crmRecordsUpdated" type="xs:long"/>
          <xs:element minOccurs="0" name="listName" type="xs:string"/>
          <xs:element name="listRecordsDeleted" type="xs:long"/>
          <xs:element name="listRecordsInserted" type="xs:long"/>
          <xs:element name="recordDispositionsReset" type="xs:long"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
```

```xml
<xs:complexType name="basicImportResult">
    <xs:sequence>
      <xs:element minOccurs="0" name="failureMessage" type="xs:string"/>
      <xs:element minOccurs="0" name="importIdentifier" type="xs:string"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="importTroubles" nillable="true" type="tns:importTrouble"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="importedRows" nillable="true" type="tns:importedRow"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="keyFields" nillable="true" type="xs:string"/>
      <xs:element name="success" type="xs:boolean"/>
      <xs:element name="uploadDuplicatesCount" type="xs:long"/>
      <xs:element name="uploadErrorsCount" type="xs:long"/>
      <xs:element name="warningsCount">
        <xs:complexType>
          <xs:sequence>
            <xs:element maxOccurs="unbounded" minOccurs="0" name="entry">
              <xs:complexType>
                <xs:sequence>
                  <xs:element minOccurs="0" name="key" type="xs:string"/>
                  <xs:element minOccurs="0" name="value" type="xs:long"/>
                </xs:sequence>
              </xs:complexType>
```


## Rollback path — asyncAddRecordsToList

```xml
<xs:complexType name="asyncAddRecordsToList">
    <xs:sequence>
      <xs:element minOccurs="0" name="listName" type="xs:string"/>
      <xs:element minOccurs="0" name="listUpdateSettings" type="tns:listUpdateSettings"/>
      <xs:element minOccurs="0" name="importData" type="tns:importData"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="resetDispositionsInCampaignsImportData" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="asyncAddRecordsToListResponse">
    <xs:sequence>
      <xs:element minOccurs="0" name="return" type="tns:importIdentifier"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="listUpdateSettings">
    <xs:complexContent>
      <xs:extension base="tns:basicImportSettings">
        <xs:sequence>
          <xs:element minOccurs="0" name="callNowColumnNumber" type="xs:int"/>
          <xs:element minOccurs="0" name="callNowMode" type="tns:callNowMode"/>
          <xs:element minOccurs="0" name="callTime" type="xs:long"/>
          <xs:element minOccurs="0" name="callTimeColumnNumber" type="xs:int"/>
          <xs:element name="cleanListBeforeUpdate" type="xs:boolean"/>
          <xs:element minOccurs="0" name="crmAddMode" type="tns:crmAddMode"/>
          <xs:element minOccurs="0" name="crmUpdateMode" type="tns:crmUpdateMode"/>
          <xs:element minOccurs="0" name="listAddMode" type="tns:listAddMode"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
```

```xml
<xs:simpleType name="listAddMode">
    <xs:restriction base="xs:string">
      <xs:enumeration value="ADD_FIRST"/>
      <xs:enumeration value="ADD_ALL"/>
      <xs:enumeration value="ADD_IF_SOLE_CRM_MATCH"/>
    </xs:restriction>
  </xs:simpleType>
```

```xml
<xs:simpleType name="crmDeleteMode">
    <xs:restriction base="xs:string">
      <xs:enumeration value="DELETE_ALL"/>
      <xs:enumeration value="DELETE_SOLE_MATCHES"/>
      <xs:enumeration value="DELETE_EXCEPT_FIRST"/>
    </xs:restriction>
  </xs:simpleType>
```
